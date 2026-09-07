import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * REAL spectrum levels for a track.
 *
 * The web panel cannot hear anything: the bot streams audio into a Discord voice channel, not
 * into the browser, so there is no client-side signal to analyse and the old bars were a fixed
 * CSS animation — pure decoration that moved the same way for every song.
 *
 * The SERVER, though, has the actual audio file on disk and knows the playback position. So the
 * file is decoded once, turned into a compact per-band energy timeline, and cached next to the
 * audio; the panel fetches that timeline and indexes into it by position. The bars are then a
 * real reading of the real track, in sync with what the channel is hearing.
 *
 * Analysis is LAZY (first time a panel asks for a track) and cached, so it never delays playback.
 */

/** Bars across the meter. Also the number of frequency bands the spectrum is folded into. */
export const BANDS = 40;

/**
 * Frames per second of analysis, and the ceiling on how many we will store.
 *
 * The client interpolates between frames, so a modest rate still looks fluid — which matters
 * because the payload is `frames × BANDS` bytes and a long DJ set would otherwise be megabytes.
 * A 6-minute track lands at 10 fps; longer ones step down to stay under the cap.
 */
export const TARGET_FPS = 10;
/** The frame count `fpsForDuration` aims for on an ordinary track. */
export const MAX_FRAMES = 3600;
/**
 * Hard ceiling on stored frames. Distinct from MAX_FRAMES: at the fps floor a very long set
 * needs more frames than the target to cover its whole runtime, and truncating there would
 * freeze the meter partway through. This bounds memory and payload instead
 * (9000 × BANDS = 360 KB worst case) while still covering ~75 minutes at the floor.
 */
export const FRAME_CEILING = 9000;
const MIN_FPS = 2;

/** Decode rate. 8 kHz keeps everything up to ~4 kHz, which is where a music meter lives. */
const SAMPLE_RATE = 8000;
/** FFT window. 512 @ 8 kHz = 64 ms — fine enough for rhythm, long enough to resolve bass. */
const FFT_SIZE = 512;

export interface TrackLevels {
  /** Frames per second the timeline was sampled at. */
  fps: number;
  /** Bands per frame (always BANDS). */
  bands: number;
  /** `frames × bands` bytes, row-major: frame 0's bands, then frame 1's, … Each 0–255. */
  data: Uint8Array;
}

/** On-disk form. `data` is base64 so the cache entry stays a plain JSON file. */
interface StoredLevels {
  v: 1;
  fps: number;
  bands: number;
  data: string;
}

/** Where a track's analysis is cached. Sits beside the audio file in CACHE_DIR. */
export function levelsPath(cacheDir: string, videoId: string): string {
  return join(cacheDir, `${videoId}.levels.json`);
}

/**
 * Pick the analysis rate for a track: TARGET_FPS, stepped down for long tracks so the stored
 * timeline stays bounded. An unknown/zero duration just uses the target — the frame loop below
 * stops when the audio does, and the cap is enforced there too.
 */
export function fpsForDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return TARGET_FPS;
  const fps = MAX_FRAMES / durationSec;
  if (fps >= TARGET_FPS) return TARGET_FPS;
  return Math.max(MIN_FPS, Math.floor(fps * 10) / 10);
}

/**
 * In-place iterative radix-2 FFT (decimation in time).
 *
 * Written out rather than pulled from a dependency: it is thirty lines, it runs on the server
 * against a decoded buffer we already have, and adding a native FFT package to the image for
 * this would be a poor trade. `re`/`im` must be the same power-of-two length.
 */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]!;
        const bi = im[i + k + len / 2]!;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Band edges in FFT bins, spaced LOGARITHMICALLY.
 *
 * Linear bins would give almost the whole meter to treble: at 8 kHz with a 512-point window each
 * bin is ~15.6 Hz, so a linear split puts everything below 600 Hz — where most of the music is —
 * into the first two bars. Log spacing is what makes the meter track what a listener hears.
 */
export function bandEdges(bands = BANDS, fftSize = FFT_SIZE, sampleRate = SAMPLE_RATE): number[] {
  const nyquistBin = fftSize / 2;
  const lowHz = 40;
  const highHz = Math.min(4000, sampleRate / 2);
  const binOf = (hz: number): number => Math.round((hz / (sampleRate / 2)) * nyquistBin);
  const edges: number[] = [];
  for (let i = 0; i <= bands; i++) {
    const hz = lowHz * Math.pow(highHz / lowHz, i / bands);
    // Every band must be at least one bin wide, or the top bands collapse onto each other.
    edges.push(Math.max(binOf(hz), (edges[i - 1] ?? 0) + 1));
  }
  return edges;
}

/**
 * Turn mono 16-bit PCM into the per-band, per-frame byte timeline.
 *
 * Pure and synchronous, so the whole analysis is testable against generated signals without
 * ffmpeg or a real file anywhere in the loop.
 */
export function computeLevels(
  pcm: Int16Array,
  fps: number,
  opts: { bands?: number; fftSize?: number; sampleRate?: number } = {},
): TrackLevels {
  const bands = opts.bands ?? BANDS;
  const fftSize = opts.fftSize ?? FFT_SIZE;
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const frameCount = Math.max(0, Math.min(FRAME_CEILING, Math.ceil(pcm.length / hop)));
  const edges = bandEdges(bands, fftSize, sampleRate);
  const out = new Uint8Array(frameCount * bands);

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  // Hann window: without it every frame's hard edges smear energy across all bins and the
  // meter reads as broadband mush instead of distinct bands.
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++)
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) {
      const s = pcm[start + i];
      re[i] = s === undefined ? 0 : (s / 32768) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bands; b++) {
      const lo = edges[b]!;
      const hi = Math.max(lo + 1, edges[b + 1]!);
      let sum = 0;
      let n = 0;
      for (let bin = lo; bin < hi && bin < fftSize / 2; bin++) {
        sum += Math.sqrt(re[bin]! * re[bin]! + im[bin]! * im[bin]!);
        n++;
      }
      // NORMALISE back to signal amplitude before anything else. An unnormalised FFT scales
      // with the window length, so a full-scale sine came out around +40 dB, every loud band
      // pinned at 255, and the meter read as a solid block instead of a spectrum. For a real
      // tone of amplitude A windowed by Hann (coherent gain 0.5) the peak bin is A·N/4, so
      // 4/N puts a full-scale sine back at 1.0 — i.e. 0 dB.
      const mag = (n > 0 ? sum / n : 0) * (4 / fftSize);
      // dB, then mapped onto the meter's floor..ceiling. Amplitude is logarithmic to the ear,
      // so a linear byte would leave the bars flat near the bottom for all normal music.
      const db = 20 * Math.log10(mag + 1e-9);
      const norm = (db + 62) / 62; // -62 dB floor → 0, 0 dB → 1
      out[f * bands + b] = Math.max(0, Math.min(255, Math.round(norm * 255)));
    }
  }
  return { fps, bands, data: out };
}

/** Decode `path` to mono 16-bit PCM at SAMPLE_RATE. Rejects if ffmpeg fails. */
function decodePcm(path: string, timeoutMs: number): Promise<Int16Array> {
  return new Promise<Int16Array>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v",
      "error",
      // ONE thread, and see the renice below. This decodes a whole track as fast as the box
      // will allow, on the same machine that is streaming audio in real time from the same
      // volume — left at full tilt it competes with playback for CPU and disk, and on a small
      // host that shows up as the music stalling. It has no deadline (the meter can wait a few
      // seconds), so it should never win that contest.
      "-threads",
      "1",
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "s16le",
      "-",
    ]);
    try {
      // Lowest priority: the scheduler hands it only cycles nothing else wants. Best-effort —
      // an unsupported platform or missing privileges just leaves it at the default.
      if (ff.pid !== undefined) setPriority(ff.pid, 19);
    } catch {
      /* not fatal: the analysis is still correct, just less polite */
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      done(() => {
        ff.kill("SIGKILL");
        reject(new Error("levels: ffmpeg timed out"));
      });
    }, timeoutMs);

    ff.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
      bytes += c.length;
    });
    // stderr is drained but never surfaced: it carries the file path, and this result is
    // reachable from the panel.
    ff.stderr.resume();
    ff.on("error", (err) => done(() => reject(err)));
    ff.on("close", (code) => {
      done(() => {
        if (code !== 0) {
          reject(new Error(`levels: ffmpeg exited ${String(code)}`));
          return;
        }
        const buf = Buffer.concat(chunks, bytes);
        // Buffer -> Int16Array over the SAME memory, honoring a possibly-odd trailing byte.
        resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
      });
    });
  });
}

export interface LevelsServiceDeps {
  cacheDir: string;
  /** Resolve a videoId to its cached audio file, or null when it is not on disk. */
  filePathFor: (videoId: string) => string | null;
  /** Budget for one ffmpeg decode. */
  timeoutMs?: number;
}

/**
 * Lazily analyse and cache a track's levels.
 *
 * Never throws: a missing file, a broken decode or an unwritable cache all resolve to null, and
 * the panel falls back to its idle meter. A visualiser is not worth a 500.
 */
export class LevelsService {
  private readonly inFlight = new Map<string, Promise<TrackLevels | null>>();

  constructor(private readonly deps: LevelsServiceDeps) {}

  async get(videoId: string, durationSec: number): Promise<TrackLevels | null> {
    const cached = await this.readCache(videoId);
    if (cached) return cached;
    // One analysis per track at a time: two panels opening the same song must not each spawn
    // an ffmpeg decode of the same file.
    const existing = this.inFlight.get(videoId);
    if (existing) return existing;
    const job = this.analyze(videoId, durationSec).finally(() => this.inFlight.delete(videoId));
    this.inFlight.set(videoId, job);
    return job;
  }

  private async analyze(videoId: string, durationSec: number): Promise<TrackLevels | null> {
    const path = this.deps.filePathFor(videoId);
    if (path === null) return null; // not downloaded (yet) — nothing to analyse
    let pcm: Int16Array;
    try {
      pcm = await decodePcm(path, this.deps.timeoutMs ?? 120_000);
    } catch {
      return null;
    }
    if (pcm.length === 0) return null;
    const seconds = durationSec > 0 ? durationSec : pcm.length / SAMPLE_RATE;
    const levels = computeLevels(pcm, fpsForDuration(seconds));
    await this.writeCache(videoId, levels);
    return levels;
  }

  private async readCache(videoId: string): Promise<TrackLevels | null> {
    try {
      const raw = await readFile(levelsPath(this.deps.cacheDir, videoId), "utf8");
      const parsed = JSON.parse(raw) as StoredLevels;
      if (parsed.v !== 1 || typeof parsed.data !== "string") return null;
      return {
        fps: parsed.fps,
        bands: parsed.bands,
        data: new Uint8Array(Buffer.from(parsed.data, "base64")),
      };
    } catch {
      return null;
    }
  }

  private async writeCache(videoId: string, levels: TrackLevels): Promise<void> {
    const target = levelsPath(this.deps.cacheDir, videoId);
    const tmp = `${target}.${randomUUID()}.tmp`;
    const body: StoredLevels = {
      v: 1,
      fps: levels.fps,
      bands: levels.bands,
      data: Buffer.from(levels.data).toString("base64"),
    };
    try {
      // Written atomically so a concurrent reader never sees a half-file.
      await writeFile(tmp, JSON.stringify(body));
      await rename(tmp, target);
    } catch {
      /* a cache that cannot be written just means we analyse again next time */
    }
  }
}
