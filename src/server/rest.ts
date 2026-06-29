import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { parseInput } from "../youtube/url-parser.js";
import { canControl } from "../auth/authz.js";
import { avatarUrl, type DiscordUser } from "../auth/oauth.js";
import { YtError } from "../youtube/errors.js";
import type { Requester, TrackMeta } from "../types/index.js";
import type { GuildSettings } from "../orchestrator/settings.js";
import type { ControllerSnapshot } from "../orchestrator/index.js";

interface Controller {
  ensureConnected(channelId: string): Promise<void>;
  moveTo(channelId: string): Promise<void>;
  connectedChannelId: string | null;
  enqueue(meta: TrackMeta, requester: Requester): Promise<{ id: string }>;
  skip(): void;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  seek(positionMs: number): Promise<boolean>;
  remove(itemId: string): Promise<boolean>;
  reorder(itemId: string, toIndex: number): Promise<boolean>;
  // Use the real orchestrator snapshot type so the declared REST surface matches what
  // GET /state actually returns (paused, repeat, autoplay, idleTimeoutSec, …) and so TS
  // flags future field divergence instead of silently narrowing.
  snapshot(): ControllerSnapshot;
  readonly settings: GuildSettings;
  updateSettings(patch: Partial<Record<keyof GuildSettings, unknown>>): GuildSettings;
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

function isAdmin(req: FastifyRequest, deps: RestDeps): boolean {
  const user = sessionUser(req);
  return user !== null && deps.adminIds.has(user.id);
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
    let moveSuppressed: { requested: string; actual: string | null } | undefined;
    // voiceChannelId is user-controlled and unvalidated: an unknown/non-voice/invalid id
    // makes moveTo/ensureConnected reject (Discord fetch error, the "not a voice channel"
    // guard, or a 30s entersState timeout). Catch it and return a 4xx instead of letting it
    // become a generic unhandled 500 that leaks the raw error message.
    try {
      if (body.voiceChannelId) {
        const connected = controller.connectedChannelId;
        if (connected && connected !== body.voiceChannelId) {
          if (isAdmin(req, deps)) {
            await controller.moveTo(body.voiceChannelId);
          } else {
            // Non-admin can't move the bot: keep it where it is, but flag the request
            // so the panel can tell the user only an admin can move it.
            moveSuppressed = { requested: body.voiceChannelId, actual: connected };
          }
        } else {
          await controller.ensureConnected(body.voiceChannelId);
        }
      } else if (controller.connectedChannelId === null) {
        // No target channel and the bot isn't in voice — the track would queue into
        // the void and never play. Reject so the panel can prompt for a channel.
        return reply.code(400).send({ error: "no_voice_channel" });
      }
    } catch {
      return reply.code(400).send({ error: "voice_connect_failed" });
    }
    const requester: Requester = {
      discordUserId: user.id,
      displayName: user.global_name ?? user.username,
      avatarUrl: avatarUrl(user),
      source: "web",
    };
    let item: { id: string };
    try {
      item = await controller.enqueue(meta, requester);
    } catch (err) {
      // The per-guild max-track-length guard (and any other enqueue rejection) surfaces
      // here. Send the human message (e.g. "Too long — max 4h …") so the panel shows it.
      if (err instanceof YtError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    return {
      queued: { id: item.id, title: meta.title },
      ...(moveSuppressed ? { moveSuppressed } : {}),
    };
  }

  for (const action of ["skip", "pause", "resume", "stop"] as const) {
    app.post<{ Params: { id: string } }>(`/api/guilds/:id/${action}`, async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const c = deps.hub.get(req.params.id);
      await Promise.resolve(c[action]());
      return { ok: true };
    });
  }

  app.post<{ Params: { id: string }; Body: { positionMs?: number } }>(
    "/api/guilds/:id/seek",
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const positionMs = Number(req.body?.positionMs);
      if (!Number.isFinite(positionMs) || positionMs < 0) {
        return reply.code(400).send({ error: "positionMs must be a non-negative number" });
      }
      const c = deps.hub.get(req.params.id);
      const current = c.snapshot().current;
      if (!current) return reply.code(409).send({ error: "nothing is playing" });
      const durationSec = current.meta?.durationSec ?? null;
      if (durationSec != null && positionMs > durationSec * 1000) {
        return reply.code(400).send({ error: "positionMs exceeds track duration" });
      }
      try {
        const ok = await c.seek(Math.round(positionMs));
        return { ok };
      } catch {
        return reply.code(400).send({ error: "seek failed" });
      }
    },
  );

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
      // Mirror the /queue/remove handler: reject a missing/empty itemId with a 400 rather
      // than passing "" through to reorder (which would findIndex -> -1 -> {ok:false}/200).
      const itemId = (req.body?.itemId ?? "").toString();
      if (!itemId) return reply.code(400).send({ error: "itemId is required" });
      const ok = await deps.hub.get(req.params.id).reorder(itemId, toIndex);
      return { ok };
    },
  );

  app.get<{ Params: { id: string } }>("/api/guilds/:id/voice-channels", async (req, reply) => {
    if (!(await requireControl(req, reply, req.params.id))) return;
    const userId = sessionUser(req)?.id ?? null;
    const guild = deps.client.guilds.cache.get(req.params.id) as
      | {
          channels?: {
            cache: Map<
              string,
              { id: string; name: string; type: number; isVoiceBased?: () => boolean }
            >;
          };
          voiceStates?: { cache: Map<string, { channelId?: string | null }> };
        }
      | undefined;
    const channels: { id: string; name: string }[] = [];
    for (const ch of guild?.channels?.cache?.values() ?? []) {
      if (ch.isVoiceBased?.() ?? false) channels.push({ id: ch.id, name: ch.name });
    }
    // The voice channel the logged-in user is currently connected to (from the
    // bot's GuildVoiceStates cache), or null if not in voice / undeterminable.
    const currentChannelId: string | null =
      (userId && guild?.voiceStates?.cache?.get(userId)?.channelId) || null;
    return { channels, currentChannelId };
  });

  // Per-guild panel settings: idle timeout (how long the bot lingers in voice after
  // playback ends), pseudo-crossfade seconds, loudness normalization, and repeat mode.
  app.get<{ Params: { id: string } }>("/api/guilds/:id/settings", async (req, reply) => {
    if (!(await requireControl(req, reply, req.params.id))) return;
    return { settings: deps.hub.get(req.params.id).settings };
  });

  app.post<{
    Params: { id: string };
    Body: Partial<Record<keyof GuildSettings, unknown>>;
  }>("/api/guilds/:id/settings", async (req, reply) => {
    if (!(await requireControl(req, reply, req.params.id))) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // updateSettings validates/clamps every field; unknown keys are ignored.
    const settings = deps.hub.get(req.params.id).updateSettings(body);
    return { settings };
  });
}
