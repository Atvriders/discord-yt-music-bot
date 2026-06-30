import type {
  GuildSettings,
  Me,
  PlaylistSummary,
  Snapshot,
  TextChannel,
  TrackMeta,
  VoiceChannel,
} from "../types.js";

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

export const api = {
  me: () => req<Me>("/api/me"),
  state: (g: string) => req<Snapshot>(`/api/guilds/${g}/state`),
  voiceChannels: (g: string) =>
    req<{ channels: VoiceChannel[]; currentChannelId: string | null }>(
      `/api/guilds/${g}/voice-channels`,
    ),
  // The guild's text channels (for the single-channel command-restriction picker).
  textChannels: (g: string) =>
    req<{ channels: TextChannel[] }>(`/api/guilds/${g}/text-channels`),
  play: (g: string, input: string, voiceChannelId?: string) =>
    post<EnqueueResult & { candidates?: TrackMeta[] }>(`/api/guilds/${g}/play`, { input, voiceChannelId }),
  pick: (g: string, videoId: string, voiceChannelId?: string) =>
    post<EnqueueResult>(`/api/guilds/${g}/pick`, { videoId, voiceChannelId }),
  control: (g: string, action: ControlAction) => post<{ ok: boolean }>(`/api/guilds/${g}/${action}`),
  seek: (g: string, positionMs: number) => post<{ ok: boolean }>(`/api/guilds/${g}/seek`, { positionMs }),
  remove: (g: string, itemId: string) => post<{ ok: boolean }>(`/api/guilds/${g}/queue/remove`, { itemId }),
  reorder: (g: string, itemId: string, toIndex: number) => post<{ ok: boolean }>(`/api/guilds/${g}/queue/reorder`, { itemId, toIndex }),
  shuffle: (g: string) => post<{ ok: boolean }>(`/api/guilds/${g}/shuffle`),
  jump: (g: string, itemId: string) => post<{ ok: boolean }>(`/api/guilds/${g}/jump`, { itemId }),
  // Best-effort lyrics for the current track. `lyrics` is null when none are found
  // (plain text match, NOT time-synced).
  lyrics: (g: string) => req<{ lyrics: string | null; source: string }>(`/api/guilds/${g}/lyrics`),
  getSettings: (g: string) => req<{ settings: GuildSettings }>(`/api/guilds/${g}/settings`),
  setSettings: (g: string, patch: Partial<GuildSettings>) =>
    post<{ settings: GuildSettings }>(`/api/guilds/${g}/settings`, patch),
  // Saved playlists (per-guild). The playlist name is path-encoded so spaces/specials survive.
  listPlaylists: (g: string) => req<{ playlists: PlaylistSummary[] }>(`/api/guilds/${g}/playlists`),
  savePlaylist: (g: string, name: string) =>
    post<{ ok: boolean; playlists: PlaylistSummary[] }>(`/api/guilds/${g}/playlists`, { name }),
  // Loading connects the bot to voice first (like play/pick), so the saved tracks
  // actually start playing instead of queueing into the void when it's disconnected.
  // The load endpoint returns its OWN shape ({ ok, queued: <count>, moveSuppressed? }) —
  // NOT EnqueueResult. Intersecting with EnqueueResult collapsed `queued` to
  // `{id,title} & number` → never; declare the real shape so `queued` is an unambiguous
  // number matching the backend (src/server/rest.ts).
  loadPlaylist: (g: string, name: string, voiceChannelId?: string) =>
    post<{ ok: boolean; queued: number; moveSuppressed?: { requested: string; actual: string | null } }>(
      `/api/guilds/${g}/playlists/${encodeURIComponent(name)}/load`,
      { voiceChannelId },
    ),
  deletePlaylist: (g: string, name: string) =>
    req<{ ok: boolean; playlists: PlaylistSummary[] }>(
      `/api/guilds/${g}/playlists/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  logout: () => post<void>("/auth/logout"),
};
