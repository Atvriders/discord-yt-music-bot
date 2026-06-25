export type LiveStatus = "not_live" | "is_live" | "is_upcoming" | "was_live" | "post_live";

export interface TrackMeta {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number | null;
  isLive: boolean;
  thumbnailUrl: string | null;
}

export type RequestSource = "discord" | "web";

export interface Requester {
  discordUserId: string;
  displayName: string;
  avatarUrl: string;
  source: RequestSource;
}

export interface QueueItem {
  id: string;
  meta: TrackMeta;
  requester: Requester;
  addedAt: number;
}
