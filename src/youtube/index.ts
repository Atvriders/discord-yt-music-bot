import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MediaConfig } from "../config.js";
import type { TrackMeta } from "../types/index.js";
import { runYtDlp } from "./ytdlp.js";
import { YtError, YtErrorKind, classifyYtdlpError } from "./errors.js";

type RunFn = typeof runYtDlp;

interface RawInfo {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  thumbnail?: string;
}

function toMeta(j: RawInfo): TrackMeta {
  const isLive =
    j.is_live === true || j.live_status === "is_live" || j.live_status === "is_upcoming";
  return {
    videoId: j.id,
    title: j.title ?? "Unknown title",
    channel: j.channel ?? j.uploader ?? "Unknown",
    durationSec: typeof j.duration === "number" ? j.duration : null,
    isLive,
    thumbnailUrl: j.thumbnail ?? null,
  };
}

export class YouTubeService {
  constructor(
    private readonly cfg: MediaConfig,
    private readonly run: RunFn = runYtDlp,
  ) {}

  private extractorArgs(): string[] {
    const args = ["--extractor-args", `youtube:player_client=${this.cfg.playerClients}`];
    if (this.cfg.ytProxy) args.push("--proxy", this.cfg.ytProxy);
    if (this.cfg.ytCookiesFile) args.push("--cookies", this.cfg.ytCookiesFile);
    return args;
  }

  async resolve(videoId: string): Promise<TrackMeta> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const { stdout, stderr, code } = await this.run(
      ["-J", "--no-playlist", "--no-warnings", "--no-progress", ...this.extractorArgs(), "--", url],
      this.cfg.ytdlpTimeoutMs,
    );
    if (code !== 0) throw classifyYtdlpError(stderr, code);

    const meta = toMeta(JSON.parse(stdout) as RawInfo);
    if (meta.isLive) throw new YtError(YtErrorKind.Live, "live streams are not supported");
    if (
      this.cfg.maxTrackDurationSec !== null &&
      meta.durationSec !== null &&
      meta.durationSec > this.cfg.maxTrackDurationSec
    ) {
      throw new YtError(
        YtErrorKind.TooLong,
        `track is ${meta.durationSec}s, over the ${this.cfg.maxTrackDurationSec}s limit`,
      );
    }
    return meta;
  }

  async search(query: string, limit = this.cfg.searchResultCount): Promise<TrackMeta[]> {
    const { stdout, stderr, code } = await this.run(
      [
        "-J",
        "--flat-playlist",
        "--no-warnings",
        "--no-progress",
        "--",
        `ytsearch${limit}:${query}`,
      ],
      this.cfg.ytdlpTimeoutMs,
    );
    if (code !== 0) throw classifyYtdlpError(stderr, code);

    const parsed = JSON.parse(stdout) as { entries?: RawInfo[] };
    return (parsed.entries ?? []).map(toMeta);
  }

  async download(videoId: string, outDir: string): Promise<string> {
    const maxMb = Math.floor(this.cfg.cacheMaxBytes / (1024 * 1024));
    const args = [
      "-f",
      "bestaudio[acodec=opus]/bestaudio/best",
      "--no-playlist",
      "--max-filesize",
      `${Math.max(1, Math.min(maxMb, 500))}M`,
      "--socket-timeout",
      "30",
      "--retries",
      "3",
      "--no-warnings",
      "--no-progress",
      ...this.extractorArgs(),
    ];
    if (this.cfg.sponsorblockRemove) {
      args.push(
        "-x",
        "--audio-format",
        "opus",
        "--sponsorblock-remove",
        this.cfg.sponsorblockRemove,
      );
    }
    args.push(
      "-o",
      join(outDir, "%(id)s.%(ext)s"),
      "--",
      `https://www.youtube.com/watch?v=${videoId}`,
    );

    const { stderr, code } = await this.run(args, this.cfg.ytdlpTimeoutMs);
    if (code !== 0) throw classifyYtdlpError(stderr, code);

    const files = await readdir(outDir);
    const produced = files.find((f) => f.startsWith(`${videoId}.`));
    if (!produced) {
      throw new YtError(
        YtErrorKind.Unknown,
        `download completed but no file for ${videoId} was found`,
      );
    }
    return join(outDir, produced);
  }
}
