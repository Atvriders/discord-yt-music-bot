import { describe, it, expect } from "vitest";
import { BANDS, bandEdges, computeLevels, fft, fpsForDuration, FRAME_CEILING } from "./index.js";

/**
 * The point of this module is that the bars are REAL. A test that only checked "some bytes came
 * out" would pass just as happily for the fixed CSS animation it replaces, so these assert the
 * property that actually matters: a known tone lands in the band that owns its frequency, and a
 * change in the audio shows up as a change in the meter.
 */

const SAMPLE_RATE = 8000;

/** `seconds` of a pure sine at `hz`, as mono 16-bit PCM. */
function tone(hz: number, seconds: number, amplitude = 0.8): Int16Array {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude * 32767);
  }
  return pcm;
}

/** The band index whose range contains `hz`. */
function bandOf(hz: number): number {
  const edges = bandEdges();
  const bin = Math.round((hz / (SAMPLE_RATE / 2)) * 256);
  for (let b = 0; b < BANDS; b++) {
    if (bin >= edges[b]! && bin < edges[b + 1]!) return b;
  }
  return BANDS - 1;
}

/** The loudest band of frame `f`. */
function peakBand(data: Uint8Array, bands: number, f: number): number {
  let best = 0;
  for (let b = 1; b < bands; b++) {
    if (data[f * bands + b]! > data[f * bands + best]!) best = b;
  }
  return best;
}

describe("fft", () => {
  it("puts a pure tone in the bin that owns its frequency", () => {
    const n = 512;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    // Exactly 8 cycles across the window → all energy belongs in bin 8.
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 8 * i) / n);
    fft(re, im);
    let peak = 0;
    for (let b = 1; b < n / 2; b++) {
      const mag = Math.hypot(re[b]!, im[b]!);
      if (mag > Math.hypot(re[peak]!, im[peak]!)) peak = b;
    }
    expect(peak).toBe(8);
  });

  it("reports a constant (DC) signal in bin 0 and nowhere else", () => {
    const n = 64;
    const re = new Float32Array(n).fill(1);
    const im = new Float32Array(n);
    fft(re, im);
    expect(Math.hypot(re[0]!, im[0]!)).toBeCloseTo(n, 3);
    for (let b = 1; b < n / 2; b++) expect(Math.hypot(re[b]!, im[b]!)).toBeLessThan(1e-3);
  });
});

describe("bandEdges", () => {
  it("is strictly increasing, so no band is empty or inverted", () => {
    const edges = bandEdges();
    expect(edges).toHaveLength(BANDS + 1);
    for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
  });

  it("spaces bands logarithmically — bass gets real estate, not one bar", () => {
    // With LINEAR spacing everything below ~600 Hz (most of the music) collapses into the first
    // couple of bars and the meter only ever shows treble. Log spacing is what stops that, so
    // the low half of the meter must cover a much narrower slice of spectrum than the top half.
    const edges = bandEdges();
    const firstHalfWidth = edges[BANDS / 2]! - edges[0]!;
    const secondHalfWidth = edges[BANDS]! - edges[BANDS / 2]!;
    expect(secondHalfWidth).toBeGreaterThan(firstHalfWidth * 2);
  });
});

describe("computeLevels", () => {
  it("peaks in the band that owns a bass tone", () => {
    const levels = computeLevels(tone(120, 2), 10);
    expect(levels.bands).toBe(BANDS);
    expect(peakBand(levels.data, levels.bands, 5)).toBe(bandOf(120));
  });

  it("peaks in a DIFFERENT, higher band for a treble tone", () => {
    const bass = computeLevels(tone(120, 2), 10);
    const treble = computeLevels(tone(2000, 2), 10);
    const bassPeak = peakBand(bass.data, bass.bands, 5);
    const treblePeak = peakBand(treble.data, treble.bands, 5);
    expect(treblePeak).toBe(bandOf(2000));
    // The meter must actually MOVE with the music, not just light up somewhere.
    expect(treblePeak).toBeGreaterThan(bassPeak);
  });

  it("follows a tone that changes over time", () => {
    // Bass for the first second, treble for the second: the peak band has to move with it.
    const a = tone(120, 1);
    const b = tone(2000, 1);
    const pcm = new Int16Array(a.length + b.length);
    pcm.set(a, 0);
    pcm.set(b, a.length);
    const levels = computeLevels(pcm, 10);
    const early = peakBand(levels.data, levels.bands, 3); // ~0.3s in
    const late = peakBand(levels.data, levels.bands, 15); // ~1.5s in
    expect(early).toBe(bandOf(120));
    expect(late).toBe(bandOf(2000));
  });

  it("reads silence as the floor and a loud tone well above it", () => {
    const silent = computeLevels(new Int16Array(SAMPLE_RATE * 1), 10);
    const loud = computeLevels(tone(500, 1), 10);
    const maxSilent = Math.max(...silent.data);
    expect(maxSilent).toBe(0);
    expect(Math.max(...loud.data)).toBeGreaterThan(120);
  });

  it("is louder for a louder take of the same tone", () => {
    const quiet = computeLevels(tone(500, 1, 0.05), 10);
    const loud = computeLevels(tone(500, 1, 0.9), 10);
    const at = (l: { data: Uint8Array; bands: number }) => l.data[5 * l.bands + bandOf(500)]!;
    expect(at(loud)).toBeGreaterThan(at(quiet));
  });

  it("produces one frame per 1/fps of audio", () => {
    const levels = computeLevels(tone(440, 3), 10);
    expect(levels.data.length / levels.bands).toBe(30);
  });

  it("never exceeds the frame ceiling, however long the track", () => {
    // Guards the payload size: frames × bands bytes go over the wire.
    const long = computeLevels(new Int16Array(SAMPLE_RATE * 4000), 10);
    expect(long.data.length / long.bands).toBeLessThanOrEqual(FRAME_CEILING);
  });

  it("handles an empty buffer without throwing", () => {
    expect(computeLevels(new Int16Array(0), 10).data).toHaveLength(0);
  });
});

describe("fpsForDuration", () => {
  it("uses the full rate for an ordinary song", () => {
    expect(fpsForDuration(210)).toBe(10);
  });

  it("steps down for a long set, and still covers the WHOLE track", () => {
    // Both halves matter: a lower rate keeps the payload sane, but the frames it produces must
    // still fit under the ceiling, or the meter would freeze partway through the set.
    const fps = fpsForDuration(3600);
    expect(fps).toBeLessThan(10);
    expect(fps * 3600).toBeLessThanOrEqual(FRAME_CEILING);
  });

  it("never drops below a rate the client can interpolate from", () => {
    expect(fpsForDuration(100_000)).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the target rate for an unknown duration", () => {
    expect(fpsForDuration(0)).toBe(10);
    expect(fpsForDuration(Number.NaN)).toBe(10);
  });
});
