export type LiveStatus = "not_live" | "is_live" | "is_upcoming" | "was_live" | "post_live";

export interface TrackMeta {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number | null;
  isLive: boolean;
  thumbnailUrl: string | null;
}

/** Real audio format of a downloaded track file. */
export interface AudioInfo {
  codec: string;
  bitrateKbps: number;
  sampleRateHz: number;
}

export type RequestSource = "discord" | "web" | "autoplay";

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
  /** Real audio format of the downloaded file; null until the track has been downloaded. */
  audio: AudioInfo | null;
}
