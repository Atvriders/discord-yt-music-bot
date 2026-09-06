import { useEffect, useState } from "react";

/**
 * The real per-band energy timeline for a track, fetched once and shared.
 *
 * The browser cannot analyse the audio itself — the bot streams into a Discord voice channel,
 * not into this page — so the server analyses the cached file and hands over a byte per band per
 * frame. Indexing that by playback position is what makes the meter read the actual song.
 */
export interface TrackLevels {
  fps: number;
  bands: number;
  /** `frames × bands` bytes, row-major. */
  data: Uint8Array;
}

// One fetch per track per page load, shared across every component that asks. The payload is
// immutable for a given videoId, so re-fetching it on a re-render would be pure waste.
const cache = new Map<string, TrackLevels | null>();
const inFlight = new Map<string, Promise<TrackLevels | null>>();

async function fetchLevels(videoId: string, durationSec: number): Promise<TrackLevels | null> {
  const url = `/api/levels/${encodeURIComponent(videoId)}?durationSec=${Math.max(0, Math.round(durationSec))}`;
  const res = await fetch(url, { credentials: "include" });
  // 404 is the ordinary "no data for this track" answer (still downloading, a live stream, a
  // decode that failed). It is not an error to report — the meter just stays idle.
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const bands = Number(res.headers.get("x-levels-bands") ?? 0);
  const fps = Number(res.headers.get("x-levels-fps") ?? 0);
  if (!Number.isFinite(bands) || bands <= 0 || !Number.isFinite(fps) || fps <= 0) return null;
  if (buf.length < bands) return null;
  return { fps, bands, data: buf };
}

export function loadTrackLevels(videoId: string, durationSec: number): Promise<TrackLevels | null> {
  const hit = cache.get(videoId);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inFlight.get(videoId);
  if (running) return running;
  const job = fetchLevels(videoId, durationSec)
    .catch(() => null)
    .then((r) => {
      cache.set(videoId, r);
      inFlight.delete(videoId);
      return r;
    });
  inFlight.set(videoId, job);
  return job;
}

/**
 * Levels for the currently-playing track, or null while they are loading / unavailable.
 *
 * A track that has just started may not be analysed yet (the server analyses on first request,
 * from the file it has just finished downloading), so a null answer is retried a few times with
 * a widening gap before the meter settles for its idle pose.
 */
export function useTrackLevels(videoId: string | null, durationSec: number): TrackLevels | null {
  const [levels, setLevels] = useState<TrackLevels | null>(null);

  useEffect(() => {
    if (!videoId) {
      setLevels(null);
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attemptLoad = (): void => {
      void loadTrackLevels(videoId, durationSec).then((r) => {
        if (cancelled) return;
        if (r) {
          setLevels(r);
          return;
        }
        // Not ready yet. Forget the null so the next try actually re-asks, and back off.
        cache.delete(videoId);
        attempt += 1;
        if (attempt > 4) {
          setLevels(null);
          return;
        }
        timer = setTimeout(attemptLoad, 1500 * attempt);
      });
    };

    setLevels(null);
    attemptLoad();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [videoId, durationSec]);

  return levels;
}

/**
 * Read one frame of the timeline at `positionMs`, interpolating between the two frames it falls
 * between and writing into `out`.
 *
 * Interpolation is what lets the server store a modest frame rate — the payload is
 * frames × bands bytes — while the meter still moves smoothly at display refresh rate.
 * Returns false when the position is outside the analysed range, so the caller can decide what
 * to show rather than being handed silence that looks like real data.
 */
export function sampleLevels(levels: TrackLevels, positionMs: number, out: Float32Array): boolean {
  const { fps, bands, data } = levels;
  const frames = Math.floor(data.length / bands);
  if (frames === 0) return false;
  const exact = (positionMs / 1000) * fps;
  if (exact < 0 || exact > frames - 1) {
    // Past the end (or before the start) — the analysis simply does not cover this moment.
    return false;
  }
  const i0 = Math.floor(exact);
  const i1 = Math.min(frames - 1, i0 + 1);
  const t = exact - i0;
  for (let b = 0; b < bands && b < out.length; b++) {
    const a = data[i0 * bands + b]!;
    const c = data[i1 * bands + b]!;
    out[b] = (a + (c - a) * t) / 255;
  }
  return true;
}
