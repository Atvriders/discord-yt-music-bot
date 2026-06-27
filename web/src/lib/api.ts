import type { Me, Snapshot, TrackMeta, VoiceChannel } from "../types.js";

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
  return (await res.json()) as T;
}
function post<T>(url: string, body?: unknown): Promise<T> {
  return req<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

export type ControlAction = "skip" | "pause" | "resume" | "stop";

export const api = {
  me: () => req<Me>("/api/me"),
  state: (g: string) => req<Snapshot>(`/api/guilds/${g}/state`),
  voiceChannels: (g: string) =>
    req<{ channels: VoiceChannel[]; currentChannelId: string | null }>(
      `/api/guilds/${g}/voice-channels`,
    ),
  play: (g: string, input: string, voiceChannelId?: string) =>
    post<{ queued?: { id: string; title: string }; candidates?: TrackMeta[] }>(`/api/guilds/${g}/play`, { input, voiceChannelId }),
  pick: (g: string, videoId: string, voiceChannelId?: string) =>
    post<{ queued?: { id: string; title: string } }>(`/api/guilds/${g}/pick`, { videoId, voiceChannelId }),
  control: (g: string, action: ControlAction) => post<{ ok: boolean }>(`/api/guilds/${g}/${action}`),
  remove: (g: string, itemId: string) => post<{ ok: boolean }>(`/api/guilds/${g}/queue/remove`, { itemId }),
  reorder: (g: string, itemId: string, toIndex: number) => post<{ ok: boolean }>(`/api/guilds/${g}/queue/reorder`, { itemId, toIndex }),
  getSettings: (g: string) => req<{ idleTimeoutSec: number }>(`/api/guilds/${g}/settings`),
  setSettings: (g: string, settings: { idleTimeoutSec: number }) =>
    post<{ ok: boolean; idleTimeoutSec: number }>(`/api/guilds/${g}/settings`, settings),
  logout: () => post<void>("/auth/logout"),
};
