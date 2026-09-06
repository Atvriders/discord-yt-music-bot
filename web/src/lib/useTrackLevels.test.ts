// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { sampleLevels, type TrackLevels } from "./useTrackLevels.js";

/**
 * `sampleLevels` is what turns a modest stored frame rate into a meter that moves at display
 * refresh rate, so the interpolation between frames is load-bearing — without it the bars step
 * 10 times a second and the meter looks like a slideshow.
 */

const BANDS = 4;

function levels(frames: number[][], fps = 10): TrackLevels {
  const data = new Uint8Array(frames.length * BANDS);
  frames.forEach((f, i) => f.forEach((v, b) => (data[i * BANDS + b] = v)));
  return { fps, bands: BANDS, data };
}

describe("sampleLevels", () => {
  it("reads a frame exactly on its boundary", () => {
    const lv = levels([
      [0, 255, 0, 0],
      [255, 0, 0, 0],
    ]);
    const out = new Float32Array(BANDS);
    expect(sampleLevels(lv, 0, out)).toBe(true);
    expect(out[1]).toBeCloseTo(1, 5);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  it("interpolates halfway between two frames", () => {
    // 0ms → frame 0, 100ms → frame 1 (at 10fps). 50ms is the midpoint of the two.
    const lv = levels([
      [0, 0, 0, 0],
      [255, 255, 255, 255],
    ]);
    const out = new Float32Array(BANDS);
    sampleLevels(lv, 50, out);
    for (const v of out) expect(v).toBeCloseTo(0.5, 2);
  });

  it("scales bytes to 0..1", () => {
    const lv = levels([[255, 128, 0, 64]]);
    const out = new Float32Array(BANDS);
    sampleLevels(lv, 0, out);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(128 / 255, 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  it("reports out-of-range instead of clamping to the last frame", () => {
    // Past the analysed end the honest answer is "no data" — clamping would freeze the meter on
    // whatever the final frame happened to be and pass it off as a live reading.
    const lv = levels([
      [255, 255, 255, 255],
      [255, 255, 255, 255],
    ]);
    const out = new Float32Array(BANDS);
    expect(sampleLevels(lv, 10_000, out)).toBe(false);
    expect(sampleLevels(lv, -1, out)).toBe(false);
  });

  it("reports false for an empty timeline", () => {
    expect(sampleLevels({ fps: 10, bands: BANDS, data: new Uint8Array(0) }, 0, new Float32Array(BANDS))).toBe(
      false,
    );
  });

  it("honors the timeline's own fps rather than assuming one", () => {
    // A long set is analysed at a lower rate; the same wall-clock position must still map to the
    // right frame or the meter would drift further out of sync the longer the track ran.
    const lv = levels(
      [
        [0, 0, 0, 0],
        [255, 255, 255, 255],
      ],
      2, // 2 fps → frame 1 is at 500ms, not 100ms
    );
    const out = new Float32Array(BANDS);
    sampleLevels(lv, 500, out);
    expect(out[0]).toBeCloseTo(1, 5);
    sampleLevels(lv, 250, out);
    expect(out[0]).toBeCloseTo(0.5, 2);
  });
});
