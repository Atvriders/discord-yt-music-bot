import type { AudioOptions } from "../orchestrator/index.js";

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

  return parts.length > 0 ? parts.join(",") : null;
}
