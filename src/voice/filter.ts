import type { AudioOptions } from "../orchestrator/index.js";

/**
 * Build the ffmpeg `-af` filter chain for a track given its audio options.
 *
 * Returns `null` when no processing is needed (so callers can keep the Opus
 * passthrough fast path).
 *
 * loudnorm  — EBU R128 single-pass normalization for consistent perceived volume.
 * afade in  — fade-IN over the first `crossfadeSec` seconds.
 * afade out — fade-OUT over the last `crossfadeSec` seconds; requires a known
 *             duration, so it is OMITTED for live streams or unknown-duration tracks.
 *
 * NOTE: this is a PSEUDO-crossfade (sequential fade-out then fade-in), not a true
 * overlapping crossfade — @discordjs/voice cannot mix two streams. See
 * orchestrator/settings.ts for the full honesty note.
 */
export function buildAudioFilter(
  audio: AudioOptions,
  durationSec: number | null,
  isLive: boolean,
): string | null {
  const parts: string[] = [];
  if (audio.normalizeLoudness) parts.push("loudnorm");

  const xf = audio.crossfadeSec;
  if (xf > 0) {
    parts.push(`afade=t=in:st=0:d=${xf}`);
    // Fade-out needs the track length; skip for live / unknown-duration tracks.
    if (!isLive && durationSec !== null && durationSec > xf) {
      const start = Math.max(0, durationSec - xf);
      parts.push(`afade=t=out:st=${start}:d=${xf}`);
    }
  }

  return parts.length > 0 ? parts.join(",") : null;
}
