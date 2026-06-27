import type { AudioInfo } from "../types.js";

export function fmtTime(totalSec: number | null): string {
  if (totalSec === null || !Number.isFinite(totalSec)) return "—:—";
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** "opus · 160 kbps · 48 kHz" — drops missing parts; returns null when nothing useful. */
export function fmtAudio(audio: AudioInfo | null): string | null {
  if (!audio) return null;
  const parts: string[] = [];
  if (audio.codec) parts.push(audio.codec);
  if (audio.bitrateKbps > 0) parts.push(`${Math.round(audio.bitrateKbps)} kbps`);
  if (audio.sampleRateHz > 0) {
    parts.push(
      `${(audio.sampleRateHz / 1000).toFixed(audio.sampleRateHz % 1000 === 0 ? 0 : 1)} kHz`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
