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
}
export interface Snapshot extends GuildSettings { current: CurrentItem | null; upcoming: QueueItem[]; history: QueueItem[]; paused: boolean; }
export interface Me { user: { id: string; username: string; avatarUrl: string }; guilds: { id: string; name: string }[]; }
export interface VoiceChannel { id: string; name: string; }
// A saved, per-guild playlist summary (mirrors the backend PlaylistSummary).
export interface PlaylistSummary { name: string; trackCount: number; savedAt: number; }
