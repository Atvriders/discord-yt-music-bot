import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { parseInput } from "../youtube/url-parser.js";
import { canControl } from "../auth/authz.js";
import { avatarUrl, type DiscordUser } from "../auth/oauth.js";
import { YtError } from "../youtube/errors.js";
import type { Requester, TrackMeta } from "../types/index.js";

interface Controller {
  ensureConnected(channelId: string): Promise<void>;
  enqueue(meta: TrackMeta, requester: Requester): Promise<{ id: string }>;
  skip(): void;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  remove(itemId: string): Promise<boolean>;
  reorder(itemId: string, toIndex: number): Promise<boolean>;
  snapshot(): { current: unknown; upcoming: { id: string }[]; history: unknown };
}
export interface RestDeps {
  hub: { get(guildId: string): Controller };
  youtube: {
    resolve(id: string): Promise<TrackMeta>;
    search(q: string, n: number): Promise<TrackMeta[]>;
  };
  client: Parameters<typeof canControl>[0];
  adminIds: ReadonlySet<string>;
  searchLimit: number;
}

function sessionUser(req: FastifyRequest): (DiscordUser & { id: string }) | null {
  const s = (req as { session?: { userId?: string; user?: DiscordUser } }).session;
  if (!s?.userId) return null;
  return (s.user ?? { id: s.userId, username: s.userId, avatar: null }) as DiscordUser;
}

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  // auth guard for all /api routes except /api/me handles its own
  async function requireLogin(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const user = sessionUser(req);
    if (!user) {
      await reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    return user.id;
  }
  async function requireControl(
    req: FastifyRequest,
    reply: FastifyReply,
    guildId: string,
  ): Promise<boolean> {
    const userId = await requireLogin(req, reply);
    if (!userId) return false;
    if (!(await canControl(deps.client, userId, guildId, deps.adminIds))) {
      await reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  }

  app.get("/api/me", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const guilds: Array<{ id: string; name: string }> = [];
    for (const [guildId, guild] of deps.client.guilds.cache) {
      if (await canControl(deps.client, user.id, guildId, deps.adminIds)) {
        guilds.push({ id: guildId, name: (guild as { name?: string }).name ?? guildId });
      }
    }
    return {
      user: {
        id: user.id,
        username: user.global_name ?? user.username,
        avatarUrl: avatarUrl(user),
      },
      guilds,
    };
  });

  app.get<{ Params: { id: string } }>("/api/guilds/:id/state", async (req, reply) => {
    if (!(await requireControl(req, reply, req.params.id))) return;
    return deps.hub.get(req.params.id).snapshot();
  });

  app.post<{ Params: { id: string }; Body: { input?: string; voiceChannelId?: string } }>(
    "/api/guilds/:id/play",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const input = (req.body?.input ?? "").toString();
      if (input.length > 2000) return reply.code(400).send({ error: "input too long" });
      const parsed = parseInput(input);
      if (parsed.kind === "reject") return reply.code(400).send({ error: parsed.reason });
      if (parsed.kind === "query") {
        return { candidates: await deps.youtube.search(parsed.query, deps.searchLimit) };
      }
      return enqueueVideo(req, reply, parsed.videoId);
    },
  );

  app.post<{ Params: { id: string }; Body: { videoId?: string; voiceChannelId?: string } }>(
    "/api/guilds/:id/pick",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const videoId = (req.body?.videoId ?? "").toString();
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId))
        return reply.code(400).send({ error: "bad videoId" });
      return enqueueVideo(req, reply, videoId);
    },
  );

  async function enqueueVideo(req: FastifyRequest, reply: FastifyReply, videoId: string) {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { voiceChannelId?: string };
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    let meta: TrackMeta;
    try {
      meta = await deps.youtube.resolve(videoId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof YtError ? err.kind : "resolve_failed" });
    }
    const controller = deps.hub.get(params.id);
    if (body.voiceChannelId) await controller.ensureConnected(body.voiceChannelId);
    const requester: Requester = {
      discordUserId: user.id,
      displayName: user.global_name ?? user.username,
      avatarUrl: avatarUrl(user),
      source: "web",
    };
    const item = await controller.enqueue(meta, requester);
    return { queued: { id: item.id, title: meta.title } };
  }

  for (const action of ["skip", "pause", "resume", "stop"] as const) {
    app.post<{ Params: { id: string } }>(`/api/guilds/:id/${action}`, async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const c = deps.hub.get(req.params.id);
      await Promise.resolve(c[action]());
      return { ok: true };
    });
  }

  app.post<{ Params: { id: string }; Body: { itemId?: string } }>(
    "/api/guilds/:id/queue/remove",
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const itemId = (req.body?.itemId ?? "").toString();
      if (!itemId) return reply.code(400).send({ error: "itemId is required" });
      const ok = await deps.hub.get(req.params.id).remove(itemId);
      return { ok };
    },
  );

  app.post<{ Params: { id: string }; Body: { itemId?: string; toIndex?: number } }>(
    "/api/guilds/:id/queue/reorder",
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const toIndex = Number(req.body?.toIndex ?? 0);
      if (!Number.isInteger(toIndex) || toIndex < 0) {
        return reply.code(400).send({ error: "toIndex must be a non-negative integer" });
      }
      const ok = await deps.hub
        .get(req.params.id)
        .reorder((req.body?.itemId ?? "").toString(), toIndex);
      return { ok };
    },
  );
}
