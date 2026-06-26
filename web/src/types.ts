export interface TrackMeta {
  videoId: string; title: string; channel: string;
  durationSec: number | null; isLive: boolean; thumbnailUrl: string | null;
}
export interface Requester {
  discordUserId: string; displayName: string; avatarUrl: string; source: "discord" | "web";
}
export interface QueueItem { id: string; meta: TrackMeta; requester: Requester; addedAt: number; }
export interface Snapshot { current: QueueItem | null; upcoming: QueueItem[]; history: QueueItem[]; }
export interface Me { user: { id: string; username: string; avatarUrl: string }; guilds: { id: string; name: string }[]; }
export interface VoiceChannel { id: string; name: string; }
