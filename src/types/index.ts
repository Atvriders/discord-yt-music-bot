export type LiveStatus = "not_live" | "is_live" | "is_upcoming" | "was_live" | "post_live";

export interface TrackMeta {
  /**
   * Stable cache/dedup key for the track. For YouTube this is the 11-char video id (and the
   * watch URL is reconstructed from it). For non-YouTube sources (e.g. SoundCloud) it is a
   * synthetic, filesystem-safe key such as "sc_12345", and `sourceUrl` carries the real URL.
   */
  videoId: string;
  title: string;
  channel: string;
  durationSec: number | null;
  isLive: boolean;
  thumbnailUrl: string | null;
  /**
   * Canonical media URL handed to yt-dlp for resolve/download. Absent for YouTube (the URL
   * is derived from `videoId`); present for other sources whose `videoId` is a synthetic key.
   * Optional so persisted YouTube snapshots/playlists (which never had it) still load cleanly.
   */
  sourceUrl?: string;
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
