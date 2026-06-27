// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { NowPlaying } from "./NowPlaying.js";
import type { CurrentItem } from "../types.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const item = (positionMs: number, durationMs: number): CurrentItem => ({
  id: "q1",
  addedAt: 0,
  positionMs,
  durationMs,
  meta: { videoId: "vvvvvvvvvvv", title: "Track", channel: "ch", durationSec: durationMs / 1000, isLive: false, thumbnailUrl: null },
  requester: { discordUserId: "1", displayName: "dj", avatarUrl: "", source: "web" },
});

describe("NowPlaying progress bar", () => {
  it("advances the displayed elapsed time over real wall-clock while playing", () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    render(<NowPlaying item={item(10_000, 100_000)} paused={false} receivedAt={t0} />);
    // Right after receipt: ~0:10 elapsed.
    expect(screen.getByText("0:10")).toBeTruthy();
    // Advance 5s of wall-clock + fire the tick interval.
    act(() => {
      vi.setSystemTime(t0 + 5_000);
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByText("0:15")).toBeTruthy();
  });

  it("freezes the elapsed time while paused", () => {
    vi.useFakeTimers();
    const t0 = 2_000_000;
    vi.setSystemTime(t0);
    render(<NowPlaying item={item(30_000, 100_000)} paused={true} receivedAt={t0} />);
    expect(screen.getByText("0:30")).toBeTruthy();
    act(() => {
      vi.setSystemTime(t0 + 9_000);
      vi.advanceTimersByTime(1_000);
    });
    // Still 0:30 — paused must not advance.
    expect(screen.getByText("0:30")).toBeTruthy();
  });

  it("renders a progress bar whose width reflects elapsed/duration", () => {
    vi.useFakeTimers();
    const t0 = 3_000_000;
    vi.setSystemTime(t0);
    render(<NowPlaying item={item(25_000, 100_000)} paused={true} receivedAt={t0} />);
    const bar = screen.getByTestId("progress-fill") as HTMLElement;
    expect(bar.style.width).toBe("25%");
  });
});
