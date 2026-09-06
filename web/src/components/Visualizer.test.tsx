// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Visualizer } from "./Visualizer.js";
import type { TrackLevels } from "../lib/useTrackLevels.js";

/**
 * The meter's contract is that it shows the REAL track. So these assert the two things that
 * distinguish it from the fixed CSS animation it replaced: bar heights follow the analysed data
 * at the current playback position, and with no data it stays at the floor instead of inventing
 * motion.
 */

afterEach(() => cleanup());

const BANDS = 40;

/** A timeline where band `b` is loud in frame `b % BANDS` and quiet elsewhere. */
function levelsWithPeakAt(band: number, frames = 4): TrackLevels {
  const data = new Uint8Array(frames * BANDS);
  for (let f = 0; f < frames; f++) data[f * BANDS + band] = 255;
  return { fps: 10, bands: BANDS, data };
}

/** Read each bar's rendered level back out of its clip-path (0 = floor, 1 = full). */
function barScales(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".viz-bar")).map((el) => {
    const m = /inset\(([\d.]+)%/.exec(el.style.clipPath);
    return m ? 1 - Number(m[1]) / 100 : 0;
  });
}

let rafCbs: FrameRequestCallback[] = [];
beforeEach(() => {
  rafCbs = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCbs.push(cb);
    return rafCbs.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // jsdom has no matchMedia; the component reads it for prefers-reduced-motion.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }));
});

/** Run the animation loop `n` times so the meter's ballistics can settle toward the target. */
function pump(n = 60): void {
  for (let i = 0; i < n; i++) {
    const cbs = rafCbs;
    rafCbs = [];
    act(() => {
      for (const cb of cbs) cb(0);
    });
  }
}

describe("Visualizer", () => {
  it("is presentational and renders one bar per analysed band", () => {
    const { container } = render(
      <Visualizer playing levels={levelsWithPeakAt(0)} getPositionMs={() => 0} />,
    );
    expect(container.querySelectorAll(".viz-bar")).toHaveLength(BANDS);
    expect(container.querySelector('[role="presentation"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("raises the bar that is loud in the analysed data, and only that one", () => {
    const { container } = render(
      <Visualizer playing levels={levelsWithPeakAt(7)} getPositionMs={() => 0} />,
    );
    pump();
    const scales = barScales(container);
    expect(scales[7]!).toBeGreaterThan(0.5);
    // Its neighbours carry no energy in this timeline, so they must stay near the floor.
    expect(scales[6]!).toBeLessThan(0.1);
    expect(scales[8]!).toBeLessThan(0.1);
  });

  it("follows the PLAYBACK POSITION — a different moment lights a different band", () => {
    // Frame 0 is loud in band 3; frame 2 (=200ms at 10fps) is loud in band 30.
    const data = new Uint8Array(4 * BANDS);
    data[0 * BANDS + 3] = 255;
    data[2 * BANDS + 30] = 255;
    const levels: TrackLevels = { fps: 10, bands: BANDS, data };

    let pos = 0;
    const { container } = render(
      <Visualizer playing levels={levels} getPositionMs={() => pos} />,
    );
    pump();
    expect(barScales(container)[3]!).toBeGreaterThan(0.5);

    pos = 200; // jump to the moment where the energy has moved up the spectrum
    pump();
    const later = barScales(container);
    expect(later[30]!).toBeGreaterThan(0.5);
    expect(later[3]!).toBeLessThan(0.2);
  });

  it("sits at the floor with NO data instead of animating something fake", () => {
    const { container } = render(<Visualizer playing levels={null} getPositionMs={() => 0} />);
    pump();
    for (const s of barScales(container)) expect(s).toBeLessThan(0.05);
  });

  it("says so when it has no signal to read", () => {
    const { getByTestId, rerender } = render(
      <Visualizer playing levels={null} getPositionMs={() => 0} />,
    );
    expect(getByTestId("levels-readout").textContent).toMatch(/NO SIGNAL/);
    rerender(<Visualizer playing levels={levelsWithPeakAt(1)} getPositionMs={() => 0} />);
    expect(getByTestId("levels-readout").textContent).toMatch(/SIGNAL/);
  });

  it("holds its reading when paused rather than falling to zero instantly", () => {
    const { getByTestId } = render(
      <Visualizer playing={false} levels={levelsWithPeakAt(5)} getPositionMs={() => 0} />,
    );
    // A paused deck is not "no signal" — it has a track, it just is not moving.
    expect(getByTestId("levels-readout").textContent).toMatch(/HOLD/);
    expect(getByTestId("viz").classList.contains("viz-on")).toBe(false);
  });

  it("falls back to the floor past the end of the analysed range", () => {
    // A track longer than its analysis (the ceiling truncates very long sets) must not read
    // whatever bytes happen to sit at the end — sampleLevels reports out-of-range and the
    // meter drops out.
    const { container } = render(
      <Visualizer playing levels={levelsWithPeakAt(9, 4)} getPositionMs={() => 60_000} />,
    );
    pump();
    for (const s of barScales(container)) expect(s).toBeLessThan(0.05);
  });
});
