/**
 * Per-guild playback settings.
 *
 * idleTimeoutSec   — how long to stay in a voice channel with nothing playing
 *                    before auto-leaving (0 disables — stay until kicked/stopped).
 * crossfadeSec     — pseudo-crossfade duration (see CROSSFADE HONESTY below). 0 = off.
 * normalizeLoudness— apply ffmpeg's `loudnorm` (EBU R128) filter to the resource so
 *                    tracks play at a consistent perceived volume.
 * repeat           — "off" (advance normally), "one" (replay the current track),
 *                    "all" (when the queue empties, re-enqueue played history).
 * autoplay         — when the queue empties (and repeat is off), keep playing music
 *                    similar to what just played. The SOURCE of the next tracks is
 *                    chosen by `autoplaySource`. See AUTOPLAY HONESTY below.
 * autoplaySource   — where autoplay pulls its next tracks from:
 *                      "radio"  — YouTube's own related/Mix feed for the last track
 *                                 (the default; same list YouTube would auto-play).
 *                      "artist" — a YouTube search for more songs by the last track's
 *                                 artist, keyed on its `channel` field. Best-effort.
 *
 * ── AUTOPLAY HONESTY ───────────────────────────────────────────────────────────
 * This is NOT a genre classifier. There is no audio analysis here. With "radio",
 * "similar" means YouTube's own related/Mix feed for the last-played video — the same
 * list YouTube would auto-play after a video, fetched via yt-dlp's flat-playlist on
 * the `RD<videoId>` mix list. With "artist", "similar" means a plain YouTube search
 * for the last track's channel/artist name — it is only as accurate as that name and
 * YouTube's search, not a verified discography. Either way the match keys off the last
 * track only, not the whole session's "genre".
 *
 * ── CROSSFADE HONESTY ──────────────────────────────────────────────────────────
 * @discordjs/voice plays exactly ONE AudioResource through a single AudioPlayer at a
 * time. There is no audio mixer / second decoder, so a TRUE crossfade (two tracks
 * overlapping, the outgoing one ducking under the incoming one) is NOT possible
 * without a custom mixing pipeline that @discordjs/voice does not provide.
 *
 * What `crossfadeSec` ACTUALLY does here is a *pseudo-crossfade*: each track is run
 * through ffmpeg's `afade` filter to add a fade-OUT over the last `crossfadeSec`
 * seconds and a fade-IN over the first `crossfadeSec` seconds. The tracks still play
 * strictly sequentially — track B only starts after track A has fully ended. The
 * audible effect is a smooth dip-to-silence then rise-from-silence at the boundary,
 * NOT a true overlap. There is therefore a brief moment of (near-)silence at the
 * seam; this is the honest limitation, documented rather than faked.
 *
 * Live streams have no known end time, so the fade-out is skipped for them (a
 * trailing fade requires the track duration); fade-in still applies.
 */
export type RepeatMode = "off" | "one" | "all";
export type AutoplaySource = "radio" | "artist";

export interface GuildSettings {
  idleTimeoutSec: number;
  crossfadeSec: number;
  normalizeLoudness: boolean;
  repeat: RepeatMode;
  autoplay: boolean;
  autoplaySource: AutoplaySource;
  /**
   * Reject tracks longer than this many seconds when enqueuing. 0 = NO LIMIT
   * (any length allowed). This is the AUTHORITATIVE, per-guild cap — the panel
   * controls it at runtime and it supersedes the global MAX_TRACK_DURATION_SEC
   * config (which now only seeds this default and acts as an absolute sanity ceiling).
   */
  maxTrackDurationSec: number;
}

export const DEFAULT_SETTINGS: GuildSettings = {
  idleTimeoutSec: 300,
  crossfadeSec: 0,
  normalizeLoudness: false,
  repeat: "off",
  autoplay: false,
  autoplaySource: "radio",
  // 0 = no limit. The host (index.ts) overrides this seed from the configured
  // MAX_TRACK_DURATION_SEC; an unset config leaves it at 0 (unlimited).
  maxTrackDurationSec: 0,
};

export const IDLE_TIMEOUT_MAX_SEC = 3600;
export const CROSSFADE_MAX_SEC = 12;
/** Sane upper bound (6h) on the per-guild max-track-length setting. */
export const MAX_TRACK_DURATION_CEILING_SEC = 21600;
const REPEAT_MODES: ReadonlySet<RepeatMode> = new Set<RepeatMode>(["off", "one", "all"]);
const AUTOPLAY_SOURCES: ReadonlySet<AutoplaySource> = new Set<AutoplaySource>(["radio", "artist"]);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Merge an untrusted partial patch onto a base settings object, clamping/validating
 * every field. Unknown or out-of-range values fall back to the current value.
 */
export function applySettingsPatch(
  base: GuildSettings,
  patch: Partial<Record<keyof GuildSettings, unknown>> | null | undefined,
): GuildSettings {
  const p = patch ?? {};
  const repeat =
    typeof p.repeat === "string" && REPEAT_MODES.has(p.repeat as RepeatMode)
      ? (p.repeat as RepeatMode)
      : base.repeat;
  const autoplaySource =
    typeof p.autoplaySource === "string" && AUTOPLAY_SOURCES.has(p.autoplaySource as AutoplaySource)
      ? (p.autoplaySource as AutoplaySource)
      : base.autoplaySource;
  return {
    idleTimeoutSec:
      p.idleTimeoutSec == null
        ? base.idleTimeoutSec
        : clampInt(p.idleTimeoutSec, 0, IDLE_TIMEOUT_MAX_SEC, base.idleTimeoutSec),
    crossfadeSec:
      p.crossfadeSec == null
        ? base.crossfadeSec
        : clampInt(p.crossfadeSec, 0, CROSSFADE_MAX_SEC, base.crossfadeSec),
    normalizeLoudness:
      typeof p.normalizeLoudness === "boolean" ? p.normalizeLoudness : base.normalizeLoudness,
    repeat,
    autoplay: typeof p.autoplay === "boolean" ? p.autoplay : base.autoplay,
    autoplaySource,
    maxTrackDurationSec:
      p.maxTrackDurationSec == null
        ? base.maxTrackDurationSec
        : clampInt(
            p.maxTrackDurationSec,
            0,
            MAX_TRACK_DURATION_CEILING_SEC,
            base.maxTrackDurationSec,
          ),
  };
}
