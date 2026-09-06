import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LevelsService, bandEdges, levelsPath, BANDS } from "./index.js";

/**
 * The ffmpeg half of the pipeline, against REAL encoded audio rather than a generated buffer.
 * computeLevels is covered by unit tests; what this adds is proof that decoding an actual opus
 * file and folding it into bands still lands the energy where it belongs — the step where a
 * wrong sample rate, channel count or sample format would quietly produce plausible garbage.
 */

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const withFfmpeg = hasFfmpeg ? describe : describe.skip;

/** Encode `seconds` of a sine at `hz` to a real opus file. */
function makeTone(path: string, hz: number, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${hz}:duration=${seconds}`,
      "-c:a",
      "libopus",
      "-y",
      path,
    ]);
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${String(code)}`)),
    );
  });
}

function bandOf(hz: number): number {
  const edges = bandEdges();
  const bin = Math.round((hz / 4000) * 256);
  for (let b = 0; b < BANDS; b++) if (bin >= edges[b]! && bin < edges[b + 1]!) return b;
  return BANDS - 1;
}
function peakBand(d: Uint8Array, bands: number, f: number): number {
  let best = 0;
  for (let b = 1; b < bands; b++) if (d[f * bands + b]! > d[f * bands + best]!) best = b;
  return best;
}

withFfmpeg("LevelsService (real ffmpeg decode)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ytbot-levels-"));
  });

  it("analyses a real opus file into the right band", async () => {
    const file = join(dir, "bass.opus");
    await makeTone(file, 120, 3);
    const svc = new LevelsService({ cacheDir: dir, filePathFor: () => file });
    const levels = await svc.get("bassbassbas", 3);
    expect(levels).not.toBeNull();
    expect(levels!.bands).toBe(BANDS);
    expect(levels!.data.length / levels!.bands).toBeGreaterThan(20);
    // Within one band of the tone's home — the decode round-trip is lossy, the analysis is not blind.
    expect(Math.abs(peakBand(levels!.data, levels!.bands, 5) - bandOf(120))).toBeLessThanOrEqual(1);
  }, 30_000);

  it("distinguishes a treble file from a bass file", async () => {
    const file = join(dir, "treble.opus");
    await makeTone(file, 2000, 3);
    const svc = new LevelsService({ cacheDir: dir, filePathFor: () => file });
    const levels = await svc.get("trebletrebl", 3);
    expect(Math.abs(peakBand(levels!.data, levels!.bands, 5) - bandOf(2000))).toBeLessThanOrEqual(
      1,
    );
  }, 30_000);

  it("caches to disk and serves the second request without the file", async () => {
    const file = join(dir, "cached.opus");
    await makeTone(file, 500, 2);
    const first = await new LevelsService({ cacheDir: dir, filePathFor: () => file }).get(
      "cachedcache",
      2,
    );
    expect(first).not.toBeNull();
    expect((await stat(levelsPath(dir, "cachedcache"))).isFile()).toBe(true);
    // A second service that cannot see the audio at all must still answer from the cache —
    // this is what keeps a panel refresh from re-decoding the track every time.
    const second = await new LevelsService({ cacheDir: dir, filePathFor: () => null }).get(
      "cachedcache",
      2,
    );
    expect(second).not.toBeNull();
    expect(second!.data.length).toBe(first!.data.length);
  }, 30_000);

  it("resolves null rather than throwing when the audio is missing or unreadable", async () => {
    const svc = new LevelsService({ cacheDir: dir, filePathFor: () => null });
    await expect(svc.get("missingmiss", 10)).resolves.toBeNull();
    const broken = new LevelsService({ cacheDir: dir, filePathFor: () => join(dir, "nope.opus") });
    await expect(broken.get("brokenbrokn", 10)).resolves.toBeNull();
  }, 30_000);
});
