import type { AudioOptions } from "../orchestrator/index.js";
import type { FxPreset } from "../orchestrator/settings.js";

/**
 * The ffmpeg `-af` fragment for each FX preset (see settings.ts FxPreset). "none" maps
 * to no fragment. nightcore/vaporwave resample-then-retime to shift pitch+speed; the
 * others are single in-place filters.
 */
const FX_FILTERS: Record<Exclude<FxPreset, "none">, string> = {
  bassboost: "bass=g=15",
  nightcore: "aresample=48000,asetrate=48000*1.25",
  vaporwave: "asetrate=48000*0.8,aresample=48000",
  eightd: "apulsator=hz=0.09",
  treble: "treble=g=10",
  karaoke: "stereotools=mlev=0.015",
};

/**
 * Build the ffmpeg `-af` filter chain for a track given its audio options.
 *
 * Returns `null` when no processing is needed (so callers can keep the Opus
 * passthrough fast path).
 *
 * loudnorm  — EBU R128 single-pass normalization for consistent perceived volume.
 * afade in  — fade-IN over the first `crossfadeSec` seconds, clamped to the (known)
 *             track length so a fade never runs past the end of a very short track.
 * afade out — fade-OUT over the last `crossfadeSec` seconds; requires a known
 *             duration, so it is OMITTED for live streams or unknown-duration tracks.
 *
 * When a `seekMs` offset is active, ffmpeg's input `-ss` means the OUTPUT stream only
 * contains the post-seek audio, so the fade-out start time (which is relative to the
 * output stream) must be computed from the REMAINING duration after the seek, not the
 * full track duration — otherwise `st=` lands past the end and the fade never fires.
 *
 * NOTE: this is a PSEUDO-crossfade (sequential fade-out then fade-in), not a true
 * overlapping crossfade — @discordjs/voice cannot mix two streams. See
 * orchestrator/settings.ts for the full honesty note.
 */
export function buildAudioFilter(
  audio: AudioOptions,
  durationSec: number | null,
  isLive: boolean,
  seekMs = 0,
): string | null {
  const parts: string[] = [];
  if (audio.normalizeLoudness) parts.push("loudnorm");

  const xf = audio.crossfadeSec;
  if (xf > 0) {
    // The output stream's playable length after a seek (ffmpeg `-ss` is an input seek).
    const effectiveDurationSec =
      !isLive && durationSec !== null ? Math.max(0, durationSec - seekMs / 1000) : null;
    // Fade-in must not outlast the (remaining) track, or it gets cut off mid-ramp.
    const fadeInDur = effectiveDurationSec !== null ? Math.min(xf, effectiveDurationSec) : xf;
    parts.push(`afade=t=in:st=0:d=${fadeInDur}`);
    // Fade-out needs the remaining length; skip for live / unknown-duration tracks.
    if (effectiveDurationSec !== null && effectiveDurationSec > xf) {
      const start = Math.max(0, effectiveDurationSec - xf);
      parts.push(`afade=t=out:st=${start}:d=${xf}`);
    }
  }

  // FX preset appended LAST so it colors the already-normalized/faded signal.
  const fx = audio.fx;
  if (fx && fx !== "none") parts.push(FX_FILTERS[fx]);

  return parts.length > 0 ? parts.join(",") : null;
}
