import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { parseInput } from "../youtube/url-parser.js";
import { canControl } from "../auth/authz.js";
import { avatarUrl, type DiscordUser } from "../auth/oauth.js";
import { YtError } from "../youtube/errors.js";
import { fetchLyrics, type LyricsResult } from "../youtube/lyrics.js";
import { resolveSpotifyQuery } from "../youtube/spotify.js";
import type { Requester, TrackMeta } from "../types/index.js";
import type { GuildSettings } from "../orchestrator/settings.js";
import type { ControllerSnapshot } from "../orchestrator/index.js";
import type { PlaylistSummary } from "../orchestrator/playlists.js";

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
  shuffle(): Promise<void>;
  jumpTo(itemId: string): Promise<boolean>;
  // Use the real orchestrator snapshot type so the declared REST surface matches what
  // GET /state actually returns (paused, repeat, autoplay, idleTimeoutSec, …) and so TS
  // flags future field divergence instead of silently narrowing.
  snapshot(): ControllerSnapshot;
  readonly settings: GuildSettings;
  updateSettings(patch: Partial<Record<keyof GuildSettings, unknown>>): GuildSettings;
  // Saved playlists (per-guild, persisted).
  savePlaylist(name: string): Promise<void>;
  loadPlaylist(name: string, requester: Requester): Promise<number>;
  listPlaylists(): PlaylistSummary[];
  deletePlaylist(name: string): Promise<boolean>;
}
/**
 * One bot as seen by the REST surface: its id/name plus its OWN client (for control auth) and
 * per-guild controller hub. Multiple bots run in one process; every guild route resolves the bot
 * by :botId first, then routes through THAT bot's hub + client. The shared services (youtube, …)
 * live once on RestDeps, not per bot.
 */
export interface RestBot {
  id: string;
  name: string;
  client: Parameters<typeof canControl>[0];
  hub: { get(guildId: string): Controller };
}
export interface RestDeps {
  registry: { list(): RestBot[]; get(id: string): RestBot | undefined };
  youtube: {
    resolve(id: string): Promise<TrackMeta>;
    search(q: string, n: number): Promise<TrackMeta[]>;
    /** Resolve a direct non-YouTube media URL (SoundCloud) to a playable track. */
    resolveUrl(url: string): Promise<TrackMeta>;
  };
  adminIds: ReadonlySet<string>;
  searchLimit: number;
  /**
   * Best-effort lyrics resolver for the current track (defaults to the lyrics.ovh-backed
   * `fetchLyrics`). Injectable so tests can stub it without hitting the network.
   */
  lyrics?: (meta: TrackMeta) => Promise<LyricsResult>;
  /**
   * Resolve a Spotify track URL to a "<track> <artist>" YouTube search string (best-effort;
   * null on failure). Defaults to the real spotify.ts resolver; injectable for tests.
   */
  spotify?: (url: string) => Promise<string | null>;
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
  // Resolve the :botId param to a bot, sending a 404 (and returning null) if it's unknown.
  // Every guild route funnels through here before touching a hub/client.
  async function requireBot(
    req: FastifyRequest,
    reply: FastifyReply,
    botId: string,
  ): Promise<RestBot | null> {
    const bot = deps.registry.get(botId);
    if (!bot) {
      await reply.code(404).send({ error: "unknown_bot" });
      return null;
    }
    return bot;
  }
  async function requireControl(
    req: FastifyRequest,
    reply: FastifyReply,
    botId: string,
    guildId: string,
  ): Promise<RestBot | null> {
    // Auth FIRST (401), THEN resolve the bot (404) — matching the WS surface and so an
    // unauthenticated caller can't probe which bot ids exist by 404-vs-401 differences.
    const userId = await requireLogin(req, reply);
    if (!userId) return null;
    const bot = await requireBot(req, reply, botId);
    if (!bot) return null;
    if (!(await canControl(bot.client, userId, guildId, deps.adminIds))) {
      await reply.code(403).send({ error: "forbidden" });
      return null;
    }
    return bot;
  }

  // The user's controllable guilds within one bot, using THAT bot's client (the same per-guild
  // canControl check as before, applied once per bot).
  async function controllableGuilds(
    bot: RestBot,
    userId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const guilds: Array<{ id: string; name: string }> = [];
    for (const [guildId, guild] of bot.client.guilds.cache) {
      if (await canControl(bot.client, userId, guildId, deps.adminIds)) {
        guilds.push({ id: guildId, name: (guild as { name?: string }).name ?? guildId });
      }
    }
    return guilds;
  }

  app.get("/api/me", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const bots = await Promise.all(
      deps.registry.list().map(async (b) => ({
        id: b.id,
        name: b.name,
        guilds: await controllableGuilds(b, user.id),
      })),
    );
    return {
      user: {
        id: user.id,
        username: user.global_name ?? user.username,
        avatarUrl: avatarUrl(user),
      },
      bots,
    };
  });

  app.get<{ Params: { botId: string; id: string } }>(
    "/api/bots/:botId/guilds/:id/state",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      return bot.hub.get(req.params.id).snapshot();
    },
  );

  // Best-effort lyrics for the currently-playing track. Always 200: returns
  // { lyrics: null } when nothing is playing or no match is found (NOT time-synced —
  // a plain text match keyed on the derived artist/title). Rate-limited because each
  // call may hit the external lyrics.ovh API.
  const lyricsOf = deps.lyrics ?? fetchLyrics;
  app.get<{ Params: { botId: string; id: string } }>(
    "/api/bots/:botId/guilds/:id/lyrics",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const current = bot.hub.get(req.params.id).snapshot().current;
      if (!current) return { lyrics: null, source: "lyrics.ovh" } satisfies LyricsResult;
      return lyricsOf(current.meta);
    },
  );

  app.post<{
    Params: { botId: string; id: string };
    Body: { input?: string; voiceChannelId?: string };
  }>(
    "/api/bots/:botId/guilds/:id/play",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const input = (req.body?.input ?? "").toString();
      if (input.length > 2000) return reply.code(400).send({ error: "input too long" });
      const parsed = parseInput(input);
      if (parsed.kind === "reject") return reply.code(400).send({ error: parsed.reason });
      if (parsed.kind === "query") {
        // Mirror the resolve handler: a yt-dlp failure throws YtError whose .message carries
        // raw stderr. Map it to a 400 with the error KIND (not message) so a search failure
        // is a clean 4xx and never leaks yt-dlp internals as an unhandled 500 body.
        try {
          return { candidates: await deps.youtube.search(parsed.query, deps.searchLimit) };
        } catch (err) {
          if (err instanceof YtError) return reply.code(400).send({ error: err.kind });
          throw err;
        }
      }
      // Spotify: resolve the track to a search string, find the closest YouTube video, play it.
      if (parsed.kind === "spotify") {
        const resolveSpotify = deps.spotify ?? resolveSpotifyQuery;
        let query: string | null;
        try {
          query = await resolveSpotify(parsed.url);
        } catch {
          query = null;
        }
        if (!query) return reply.code(400).send({ error: "spotify_unresolved" });
        let results: TrackMeta[];
        try {
          results = await deps.youtube.search(query, 1);
        } catch (err) {
          if (err instanceof YtError) return reply.code(400).send({ error: err.kind });
          throw err;
        }
        const match = results[0];
        if (!match) return reply.code(400).send({ error: "spotify_no_match" });
        return enqueueMeta(req, reply, bot, match, "spotify");
      }
      // SoundCloud (direct URL): resolve the exact track, then enqueue like a video.
      if (parsed.kind === "url") {
        let meta: TrackMeta;
        try {
          meta = await deps.youtube.resolveUrl(parsed.url);
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof YtError ? err.kind : "resolve_failed" });
        }
        return enqueueMeta(req, reply, bot, meta, parsed.source);
      }
      return enqueueVideo(req, reply, bot, parsed.videoId);
    },
  );

  app.post<{
    Params: { botId: string; id: string };
    Body: { videoId?: string; voiceChannelId?: string };
  }>(
    "/api/bots/:botId/guilds/:id/pick",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const videoId = (req.body?.videoId ?? "").toString();
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId))
        return reply.code(400).send({ error: "bad videoId" });
      return enqueueVideo(req, reply, bot, videoId);
    },
  );

  /**
   * Connect/move the bot to the requested voice target BEFORE enqueueing, so a track (or
   * a loaded playlist) never queues into the void. Shared by play/pick and playlist-load.
   *
   * Returns either an outcome the caller can proceed with (`{ ok: true, moveSuppressed? }`)
   * or an `{ error }` to send as a 400 (`no_voice_channel` / `voice_connect_failed`),
   * matching the existing play/pick semantics:
   *  - voiceChannelId set + connected elsewhere → admin moveTo, else moveSuppressed (stays put);
   *  - voiceChannelId set + not there yet → ensureConnected;
   *  - no voiceChannelId + disconnected → no_voice_channel (reject).
   */
  async function ensureVoiceTarget(
    req: FastifyRequest,
    controller: Controller,
    voiceChannelId: string | undefined,
  ): Promise<
    | { ok: true; moveSuppressed?: { requested: string; actual: string | null } }
    | { error: "no_voice_channel" | "voice_connect_failed" }
  > {
    // voiceChannelId is user-controlled and unvalidated: an unknown/non-voice/invalid id
    // makes moveTo/ensureConnected reject (Discord fetch error, the "not a voice channel"
    // guard, or a 30s entersState timeout). Catch it and return a 4xx instead of letting it
    // become a generic unhandled 500 that leaks the raw error message.
    try {
      if (voiceChannelId) {
        const connected = controller.connectedChannelId;
        if (connected && connected !== voiceChannelId) {
          if (isAdmin(req, deps)) {
            await controller.moveTo(voiceChannelId);
          } else {
            // Non-admin can't move the bot: keep it where it is, but flag the request
            // so the panel can tell the user only an admin can move it.
            return { ok: true, moveSuppressed: { requested: voiceChannelId, actual: connected } };
          }
        } else {
          await controller.ensureConnected(voiceChannelId);
        }
      } else if (controller.connectedChannelId === null) {
        // No target channel and the bot isn't in voice — the track would queue into
        // the void and never play. Reject so the panel can prompt for a channel.
        return { error: "no_voice_channel" };
      }
    } catch {
      return { error: "voice_connect_failed" };
    }
    return { ok: true };
  }

  /** Build the web-attributed Requester from the authenticated session user. */
  function webRequester(user: DiscordUser & { id: string }): Requester {
    return {
      discordUserId: user.id,
      displayName: user.global_name ?? user.username,
      avatarUrl: avatarUrl(user),
      source: "web",
    };
  }

  /**
   * Enqueue an already-resolved track and build the /play response. Shared tail of the
   * video / SoundCloud / Spotify paths. `source` (e.g. "soundcloud" | "spotify"), when set,
   * is echoed on `queued.source` so the panel can label how the track was resolved.
   */
  async function finishEnqueue(
    reply: FastifyReply,
    controller: Controller,
    meta: TrackMeta,
    requester: Requester,
    moveSuppressed: { requested: string; actual: string | null } | undefined,
    source?: string,
  ) {
    let item: { id: string };
    try {
      item = await controller.enqueue(meta, requester);
    } catch (err) {
      // The per-guild max-track-length guard (and any other enqueue rejection) surfaces
      // here. Send the human message (e.g. "Too long — max 4h …") so the panel shows it.
      if (err instanceof YtError) {
        return reply.code(400).send({ error: err.message });
      }
      // Any other enqueue failure (e.g. an unexpected internal error) is an infrastructure
      // problem, not a user error. Return a sanitised 500 rather than rethrowing, so the raw
      // error message / stack is never leaked to the client.
      return reply.code(500).send({ error: "enqueue_failed" });
    }
    return {
      queued: { id: item.id, title: meta.title, ...(source ? { source } : {}) },
      ...(moveSuppressed ? { moveSuppressed } : {}),
    };
  }

  async function enqueueVideo(
    req: FastifyRequest,
    reply: FastifyReply,
    bot: RestBot,
    videoId: string,
  ) {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { voiceChannelId?: string };
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const controller = bot.hub.get(params.id);
    // Validate/connect the voice target BEFORE the (multi-second) YouTube resolve so a doomed
    // request (no_voice_channel / voice_connect_failed) returns immediately instead of after a
    // wasted round-trip — and so this matches the playlist-load path which checks voice first.
    const voice = await ensureVoiceTarget(req, controller, body.voiceChannelId);
    if ("error" in voice) return reply.code(400).send({ error: voice.error });
    let meta: TrackMeta;
    try {
      meta = await deps.youtube.resolve(videoId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof YtError ? err.kind : "resolve_failed" });
    }
    return finishEnqueue(reply, controller, meta, webRequester(user), voice.moveSuppressed);
  }

  /**
   * Enqueue an ALREADY-resolved track (SoundCloud direct / Spotify→YouTube match). Mirrors
   * enqueueVideo minus the YouTube resolve, still checking the voice target first.
   */
  async function enqueueMeta(
    req: FastifyRequest,
    reply: FastifyReply,
    bot: RestBot,
    meta: TrackMeta,
    source?: string,
  ) {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { voiceChannelId?: string };
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const controller = bot.hub.get(params.id);
    const voice = await ensureVoiceTarget(req, controller, body.voiceChannelId);
    if ("error" in voice) return reply.code(400).send({ error: voice.error });
    return finishEnqueue(reply, controller, meta, webRequester(user), voice.moveSuppressed, source);
  }

  for (const action of ["skip", "pause", "resume", "stop"] as const) {
    app.post<{ Params: { botId: string; id: string } }>(
      `/api/bots/:botId/guilds/:id/${action}`,
      async (req, reply) => {
        const bot = await requireControl(req, reply, req.params.botId, req.params.id);
        if (!bot) return;
        const c = bot.hub.get(req.params.id);
        await Promise.resolve(c[action]());
        return { ok: true };
      },
    );
  }

  app.post<{ Params: { botId: string; id: string }; Body: { positionMs?: number } }>(
    "/api/bots/:botId/guilds/:id/seek",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const positionMs = Number(req.body?.positionMs);
      if (!Number.isFinite(positionMs) || positionMs < 0) {
        return reply.code(400).send({ error: "positionMs must be a non-negative number" });
      }
      const c = bot.hub.get(req.params.id);
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

  app.post<{ Params: { botId: string; id: string }; Body: { itemId?: string } }>(
    "/api/bots/:botId/guilds/:id/queue/remove",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const itemId = (req.body?.itemId ?? "").toString();
      if (!itemId) return reply.code(400).send({ error: "itemId is required" });
      const ok = await bot.hub.get(req.params.id).remove(itemId);
      return { ok };
    },
  );

  app.post<{ Params: { botId: string; id: string }; Body: { itemId?: string; toIndex?: number } }>(
    "/api/bots/:botId/guilds/:id/queue/reorder",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const toIndex = Number(req.body?.toIndex ?? 0);
      if (!Number.isInteger(toIndex) || toIndex < 0) {
        return reply.code(400).send({ error: "toIndex must be a non-negative integer" });
      }
      // Mirror the /queue/remove handler: reject a missing/empty itemId with a 400 rather
      // than passing "" through to reorder (which would findIndex -> -1 -> {ok:false}/200).
      const itemId = (req.body?.itemId ?? "").toString();
      if (!itemId) return reply.code(400).send({ error: "itemId is required" });
      const ok = await bot.hub.get(req.params.id).reorder(itemId, toIndex);
      return { ok };
    },
  );

  app.post<{ Params: { botId: string; id: string } }>(
    "/api/bots/:botId/guilds/:id/shuffle",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      await bot.hub.get(req.params.id).shuffle();
      return { ok: true };
    },
  );

  app.post<{ Params: { botId: string; id: string }; Body: { itemId?: string } }>(
    "/api/bots/:botId/guilds/:id/jump",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const itemId = (req.body?.itemId ?? "").toString();
      if (!itemId) return reply.code(400).send({ error: "itemId is required" });
      const ok = await bot.hub.get(req.params.id).jumpTo(itemId);
      return { ok };
    },
  );

  app.get<{ Params: { botId: string; id: string } }>(
    "/api/bots/:botId/guilds/:id/voice-channels",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const userId = sessionUser(req)?.id ?? null;
      const guild = bot.client.guilds.cache.get(req.params.id) as
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
    },
  );

  // The guild's TEXT channels (for the single-channel command restriction picker). Mirrors
  // the voice-channels endpoint. A discord.js voice channel is also "text-based" (it has a
  // chat), so we exclude voice channels explicitly — this returns true text channels only.
  app.get<{ Params: { botId: string; id: string } }>(
    "/api/bots/:botId/guilds/:id/text-channels",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const guild = bot.client.guilds.cache.get(req.params.id) as
        | {
            channels?: {
              cache: Map<
                string,
                {
                  id: string;
                  name: string;
                  type: number;
                  isTextBased?: () => boolean;
                  isVoiceBased?: () => boolean;
                }
              >;
            };
          }
        | undefined;
      const channels: { id: string; name: string }[] = [];
      for (const ch of guild?.channels?.cache?.values() ?? []) {
        const textBased = ch.isTextBased?.() ?? false;
        const voiceBased = ch.isVoiceBased?.() ?? false;
        if (textBased && !voiceBased) channels.push({ id: ch.id, name: ch.name });
      }
      return { channels };
    },
  );

  // Per-guild panel settings: idle timeout (how long the bot lingers in voice after
  // playback ends), pseudo-crossfade seconds, loudness normalization, and repeat mode.
  app.get<{ Params: { botId: string; id: string } }>(
    "/api/bots/:botId/guilds/:id/settings",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      return { settings: bot.hub.get(req.params.id).settings };
    },
  );

  app.post<{
    Params: { botId: string; id: string };
    Body: Partial<Record<keyof GuildSettings, unknown>>;
  }>("/api/bots/:botId/guilds/:id/settings", async (req, reply) => {
    const bot = await requireControl(req, reply, req.params.botId, req.params.id);
    if (!bot) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // updateSettings validates/clamps every field; unknown keys are ignored.
    const settings = bot.hub.get(req.params.id).updateSettings(body);
    return { settings };
  });

  // ── Saved playlists (per-guild, persisted) ──────────────────────────────────────
  // List this guild's saved playlists.
  app.get<{ Params: { botId: string; id: string } }>(
    "/api/bots/:botId/guilds/:id/playlists",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      return { playlists: bot.hub.get(req.params.id).listPlaylists() };
    },
  );

  // Save the current + upcoming queue as a named playlist.
  app.post<{ Params: { botId: string; id: string }; Body: { name?: string } }>(
    "/api/bots/:botId/guilds/:id/playlists",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      const name = (req.body?.name ?? "").toString().trim();
      if (!name) return reply.code(400).send({ error: "name is required" });
      try {
        await bot.hub.get(req.params.id).savePlaylist(name);
      } catch (err) {
        // Distinguish expected DOMAIN errors (blank name / empty queue) from infrastructure
        // I/O errors (ENOSPC/EACCES/ENOENT from persist()'s mkdir+writeFile+rename). Only the
        // former are 400s with their message; an I/O failure is a 500 with a generic message
        // so the raw fs error (which embeds the server-side filesystem path) never leaks.
        const msg = err instanceof Error ? err.message : "";
        if (msg.startsWith("playlist name") || msg.startsWith("cannot save")) {
          return reply.code(400).send({ error: msg });
        }
        return reply.code(500).send({ error: "could not save playlist" });
      }
      return { ok: true, playlists: bot.hub.get(req.params.id).listPlaylists() };
    },
  );

  // Load (enqueue) a named playlist, attributed to the requesting web user. Like play/pick,
  // it connects the bot to voice first (optional `voiceChannelId`) so the loaded tracks
  // actually start playing instead of queueing into the void when the bot is disconnected.
  app.post<{
    Params: { botId: string; id: string; name: string };
    Body: { voiceChannelId?: string };
  }>("/api/bots/:botId/guilds/:id/playlists/:name/load", async (req, reply) => {
    const bot = await requireControl(req, reply, req.params.botId, req.params.id);
    if (!bot) return;
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const controller = bot.hub.get(req.params.id);
    const voice = await ensureVoiceTarget(req, controller, req.body?.voiceChannelId);
    if ("error" in voice) return reply.code(400).send({ error: voice.error });
    const requester: Requester = {
      discordUserId: user.id,
      displayName: user.global_name ?? user.username,
      avatarUrl: avatarUrl(user),
      source: "web",
    };
    // find-my-way (Fastify's router) already percent-decodes path params, so req.params.name
    // is the real name. A second decodeURIComponent here would throw URIError -> unhandled
    // 500 for any saved name containing a literal '%' (e.g. "50% off" arrives URL-encoded as
    // "50%25off", decoded once to "50%off", then a second decode throws).
    const name = req.params.name;
    // loadPlaylist enqueues the saved tracks and calls maybeStart(), so playback begins
    // immediately now that the bot is connected.
    const count = await controller.loadPlaylist(name, requester);
    if (count === 0) return reply.code(404).send({ error: "playlist not found" });
    return {
      ok: true,
      queued: count,
      ...(voice.moveSuppressed ? { moveSuppressed: voice.moveSuppressed } : {}),
    };
  });

  // Delete a named playlist.
  app.delete<{ Params: { botId: string; id: string; name: string } }>(
    "/api/bots/:botId/guilds/:id/playlists/:name",
    async (req, reply) => {
      const bot = await requireControl(req, reply, req.params.botId, req.params.id);
      if (!bot) return;
      // find-my-way already percent-decodes path params; a second decode would throw
      // URIError -> unhandled 500 for any name containing a literal '%'. See the load route.
      const name = req.params.name;
      const existed = await bot.hub.get(req.params.id).deletePlaylist(name);
      if (!existed) return reply.code(404).send({ error: "playlist not found" });
      return { ok: true, playlists: bot.hub.get(req.params.id).listPlaylists() };
    },
  );
}
