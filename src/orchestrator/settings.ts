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

export interface GuildSettings {
  idleTimeoutSec: number;
  crossfadeSec: number;
  normalizeLoudness: boolean;
  repeat: RepeatMode;
}

export const DEFAULT_SETTINGS: GuildSettings = {
  idleTimeoutSec: 300,
  crossfadeSec: 0,
  normalizeLoudness: false,
  repeat: "off",
};

export const IDLE_TIMEOUT_MAX_SEC = 3600;
export const CROSSFADE_MAX_SEC = 12;
const REPEAT_MODES: ReadonlySet<RepeatMode> = new Set<RepeatMode>(["off", "one", "all"]);

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
  return {
    idleTimeoutSec:
      p.idleTimeoutSec === undefined
        ? base.idleTimeoutSec
        : clampInt(p.idleTimeoutSec, 0, IDLE_TIMEOUT_MAX_SEC, base.idleTimeoutSec),
    crossfadeSec:
      p.crossfadeSec === undefined
        ? base.crossfadeSec
        : clampInt(p.crossfadeSec, 0, CROSSFADE_MAX_SEC, base.crossfadeSec),
    normalizeLoudness:
      typeof p.normalizeLoudness === "boolean" ? p.normalizeLoudness : base.normalizeLoudness,
    repeat,
  };
}
