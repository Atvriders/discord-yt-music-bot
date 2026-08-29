export interface TrackMeta {
  videoId: string; title: string; channel: string;
  durationSec: number | null; isLive: boolean; thumbnailUrl: string | null;
}
// Mirrors the backend RequestSource (src/types/index.ts): autoplay-enqueued tracks
// arrive over the WS with source "autoplay", so the union must include it.
export type RequestSource = "discord" | "web" | "autoplay";
export interface Requester {
  discordUserId: string; displayName: string; avatarUrl: string; source: RequestSource;
}
export interface AudioInfo { codec: string; bitrateKbps: number; sampleRateHz: number; }
export interface QueueItem { id: string; meta: TrackMeta; requester: Requester; addedAt: number; audio: AudioInfo | null; }
// The now-playing item carries elapsed-position info for the (display-only) progress bar.
export type CurrentItem = QueueItem & { positionMs: number; durationMs: number };
export type RepeatMode = "off" | "one" | "all";
export type AutoplaySource = "radio" | "artist";
export type FxPreset =
  | "none"
  | "bassboost"
  | "nightcore"
  | "vaporwave"
  | "eightd"
  | "treble"
  | "karaoke";
export interface GuildSettings {
  idleTimeoutSec: number;
  crossfadeSec: number;
  normalizeLoudness: boolean;
  repeat: RepeatMode;
  autoplay: boolean;
  autoplaySource: AutoplaySource;
  /** Per-guild max track length (seconds) accepted on enqueue; 0 = no limit. */
  maxTrackDurationSec: number;
  /** Playback volume percentage (0–200, 100 = unchanged). */
  volume: number;
  /** Audio FX preset (none | bassboost | nightcore | vaporwave | eightd | treble | karaoke). */
  fx: FxPreset;
  /**
   * Restrict the bot to a single text channel id, or null = any channel (unrestricted,
   * the default). When set, the bot only accepts `?` commands in that channel and posts
   * its messages (live now-playing card, command replies) there.
   */
  commandChannelId: string | null;
}
// The track currently being FETCHED for playback, surfaced so the panel can show a live
// "⬇ Downloading … 45%" status (mirrors the backend PreparingState).
export type PreparingPhase = "resolving" | "downloading" | "processing";
export interface PreparingState {
  videoId: string;
  title: string;
  phase: PreparingPhase;
  /** Download completion 0–100; present during the downloading phase. */
  percent?: number;
}
export interface Snapshot extends GuildSettings { current: CurrentItem | null; upcoming: QueueItem[]; history: QueueItem[]; paused: boolean; preparing: PreparingState | null; }
// A guild the panel can control — the same shape the server has always sent under
// /api/me's guilds (id + name). Now nested under a bot (each bot lists only the guilds
// that bot is in AND the user can control).
export interface Guild { id: string; name: string; }
// One Discord bot in the multi-bot deployment. Each bot runs independently (its own voice
// connection / player), so guild-scoped calls and the live WS are addressed by (botId, guildId).
export interface Bot { id: string; name: string; guilds: Guild[]; }
export interface Me { user: { id: string; username: string; avatarUrl: string }; bots: Bot[]; }
export interface VoiceChannel { id: string; name: string; }
export interface TextChannel { id: string; name: string; }
// A saved, per-guild playlist summary (mirrors the backend PlaylistSummary).
export interface PlaylistSummary { name: string; trackCount: number; savedAt: number; }

// ── Cookie console (mirrors src/cookies/index.ts) ──────────────────────────────────────────
// These endpoints answer with HEALTH and VERDICTS only. No cookie name and no cookie value is
// ever part of a response, by construction on the server — so nothing the panel renders here
// can leak the signed-in Google session.

/** Where the jar in place came from. "env" = the deploy config (YT_COOKIES / YT_COOKIES_TEXT). */
export type CookieSource = "env" | "paste" | "browser" | "none";

/** GET /api/cookies — everything the operator console is allowed to know. */
export interface CookieHealth {
  /** A cookie jar exists on disk. */
  configured: boolean;
  source: CookieSource;
  /** Epoch ms the jar was last written by the console (null for an env/mounted jar). */
  updatedAt: number | null;
  /** The last REAL extraction probe, or null if it has never been run. */
  lastCheck: { at: number; ok: boolean; reason: string | null } | null;
  /** The chromium sidecar profile is mounted and readable — enables the import button. */
  browserProfileAvailable: boolean;
}

/**
 * POST /api/cookies, /api/cookies/test, /api/cookies/import. `reason` is operator-facing prose
 * from the server's own fixed vocabulary. `warning` rides ALONGSIDE a success: the operation
 * worked and there is still something the operator needs to hear (a jar with no sign-in cookie,
 * an import that dropped cookies it could not decrypt).
 */
export interface CookieResult {
  ok: boolean;
  reason: string | null;
  warning?: string | null;
}
