import type {
  GuildSettings,
  Me,
  PlaylistSummary,
  Snapshot,
  TextChannel,
  TrackMeta,
  VoiceChannel,
} from "../types.js";

// Every previously guild-scoped endpoint now lives under a bot: /api/bots/:botId/guilds/:guildId/…
// (same method / body / response, just prefixed). This builds that base path so each call
// stays a single readable template literal.
function base(botId: string, guildId: string): string {
  return `/api/bots/${botId}/guilds/${guildId}`;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = ((await res.json()) as { error?: string }).error ?? detail; } catch { /* ignore */ }
    throw new ApiError(res.status, detail);
  }
  // Some endpoints (e.g. logout) return an empty 204 body; calling res.json() on
  // those throws. Short-circuit before parsing.
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  return (await res.json()) as T;
}
function post<T>(url: string, body?: unknown): Promise<T> {
  // Only send a JSON content-type when there is actually a body. Fastify rejects an
  // empty body sent with `content-type: application/json` (FST_ERR_CTP_EMPTY_JSON_BODY
  // → 400), which would break bodyless control POSTs (pause/resume/skip/stop).
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return req<T>(url, init);
}

export type ControlAction = "skip" | "pause" | "resume" | "stop";

// A successful enqueue. `moveSuppressed` is set when a non-admin asked to move the
// bot to a different channel: the track is still queued, but the bot stays put.
export interface EnqueueResult {
  queued?: { id: string; title: string };
  moveSuppressed?: { requested: string; actual: string | null };
}

// Every guild-scoped call now takes the owning bot id as its FIRST argument (b) and the
// guild id as the second (g), and routes under /api/bots/:botId/guilds/:guildId/… — the
// same method / body / response as before, just addressed to a specific bot in the fleet.
export const api = {
  me: () => req<Me>("/api/me"),
  state: (b: string, g: string) => req<Snapshot>(`${base(b, g)}/state`),
  voiceChannels: (b: string, g: string) =>
    req<{ channels: VoiceChannel[]; currentChannelId: string | null }>(
      `${base(b, g)}/voice-channels`,
    ),
  // The guild's text channels (for the single-channel command-restriction picker).
  textChannels: (b: string, g: string) =>
    req<{ channels: TextChannel[] }>(`${base(b, g)}/text-channels`),
  play: (b: string, g: string, input: string, voiceChannelId?: string) =>
    post<EnqueueResult & { candidates?: TrackMeta[] }>(`${base(b, g)}/play`, { input, voiceChannelId }),
  pick: (b: string, g: string, videoId: string, voiceChannelId?: string) =>
    post<EnqueueResult>(`${base(b, g)}/pick`, { videoId, voiceChannelId }),
  control: (b: string, g: string, action: ControlAction) => post<{ ok: boolean }>(`${base(b, g)}/${action}`),
  seek: (b: string, g: string, positionMs: number) => post<{ ok: boolean }>(`${base(b, g)}/seek`, { positionMs }),
  remove: (b: string, g: string, itemId: string) => post<{ ok: boolean }>(`${base(b, g)}/queue/remove`, { itemId }),
  reorder: (b: string, g: string, itemId: string, toIndex: number) => post<{ ok: boolean }>(`${base(b, g)}/queue/reorder`, { itemId, toIndex }),
  shuffle: (b: string, g: string) => post<{ ok: boolean }>(`${base(b, g)}/shuffle`),
  jump: (b: string, g: string, itemId: string) => post<{ ok: boolean }>(`${base(b, g)}/jump`, { itemId }),
  // Best-effort lyrics for the current track. `lyrics` is null when none are found
  // (plain text match, NOT time-synced).
  lyrics: (b: string, g: string) => req<{ lyrics: string | null; source: string }>(`${base(b, g)}/lyrics`),
  getSettings: (b: string, g: string) => req<{ settings: GuildSettings }>(`${base(b, g)}/settings`),
  setSettings: (b: string, g: string, patch: Partial<GuildSettings>) =>
    post<{ settings: GuildSettings }>(`${base(b, g)}/settings`, patch),
  // Saved playlists (per-guild). The playlist name is path-encoded so spaces/specials survive.
  listPlaylists: (b: string, g: string) => req<{ playlists: PlaylistSummary[] }>(`${base(b, g)}/playlists`),
  savePlaylist: (b: string, g: string, name: string) =>
    post<{ ok: boolean; playlists: PlaylistSummary[] }>(`${base(b, g)}/playlists`, { name }),
  // Loading connects the bot to voice first (like play/pick), so the saved tracks
  // actually start playing instead of queueing into the void when it's disconnected.
  // The load endpoint returns its OWN shape ({ ok, queued: <count>, moveSuppressed? }) —
  // NOT EnqueueResult. Intersecting with EnqueueResult collapsed `queued` to
  // `{id,title} & number` → never; declare the real shape so `queued` is an unambiguous
  // number matching the backend (src/server/rest.ts).
  loadPlaylist: (b: string, g: string, name: string, voiceChannelId?: string) =>
    post<{ ok: boolean; queued: number; moveSuppressed?: { requested: string; actual: string | null } }>(
      `${base(b, g)}/playlists/${encodeURIComponent(name)}/load`,
      { voiceChannelId },
    ),
  deletePlaylist: (b: string, g: string, name: string) =>
    req<{ ok: boolean; playlists: PlaylistSummary[] }>(
      `${base(b, g)}/playlists/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  logout: () => post<void>("/auth/logout"),
};

// The live-state WebSocket URL for a (bot, guild). Previously `/ws?guildId=…`; now the
// botId is threaded in too so the server knows which bot's player to stream.
export function wsUrl(botId: string, guildId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = `botId=${encodeURIComponent(botId)}&guildId=${encodeURIComponent(guildId)}`;
  return `${proto}://${location.host}/ws?${q}`;
}
