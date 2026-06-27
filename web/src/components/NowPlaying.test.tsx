// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { NowPlaying } from "./NowPlaying.js";
import type { CurrentItem } from "../types.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function stubRect(width = 1000, left = 0) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width, left, right: left + width, top: 0, bottom: 6, height: 6, x: left, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

// jsdom's PointerEvent does NOT carry clientX (it isn't a real MouseEvent subclass), so
// fireEvent.pointer* loses the coordinate. Dispatch a MouseEvent with the pointer type
// instead — React reads e.clientX off it correctly. setPointerCapture is also absent in
// jsdom, so stub it on the target.
function pointer(el: Element, type: string, clientX: number) {
  (el as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture ??= () => {};
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  act(() => {
    el.dispatchEvent(ev);
  });
}

const item = (
  positionMs: number,
  durationMs: number,
  audio: CurrentItem["audio"] = null,
): CurrentItem => ({
  id: "q1",
  addedAt: 0,
  positionMs,
  durationMs,
  audio,
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

  it("shows the real audio track-info when present", () => {
    render(
      <NowPlaying
        item={item(0, 100_000, { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 })}
        paused={true}
        receivedAt={0}
      />,
    );
    expect(screen.getByText("opus · 160 kbps · 48 kHz")).toBeTruthy();
  });

  it("renders no audio line when audio is null", () => {
    render(<NowPlaying item={item(0, 100_000, null)} paused={true} receivedAt={0} />);
    expect(screen.queryByText(/kbps/)).toBeNull();
  });
});

describe("NowPlaying scrubbing", () => {
  it("is read-only (role=progressbar, no slider) when canSeek is false", () => {
    render(<NowPlaying item={item(0, 100_000)} paused={true} receivedAt={0} />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("exposes a slider when canSeek and the track has a duration", () => {
    render(<NowPlaying item={item(0, 100_000)} paused={true} receivedAt={0} canSeek onSeek={() => {}} />);
    expect(screen.getByRole("slider", { name: /seek/i })).toBeTruthy();
  });

  it("stays read-only for a live stream (no duration) even when canSeek", () => {
    render(<NowPlaying item={item(0, 0)} paused={true} receivedAt={0} canSeek onSeek={() => {}} />);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("calls onSeek with the released position (25% of a 200s track => 50s)", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    render(<NowPlaying item={item(0, 200_000)} paused={true} receivedAt={0} canSeek onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 250);
    pointer(slider, "pointerup", 250);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek.mock.calls[0]![0]).toBe(50_000);
  });

  it("clamps a release past the end to the track duration", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    render(<NowPlaying item={item(0, 200_000)} paused={true} receivedAt={0} canSeek onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 5000);
    pointer(slider, "pointerup", 5000);
    expect(onSeek).toHaveBeenCalledWith(200_000);
  });

  it("shows the dragged position locally while scrubbing (before release)", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    render(<NowPlaying item={item(0, 200_000)} paused={true} receivedAt={0} canSeek onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: /seek/i });
    // Drag to 50% (=100s -> 1:40) without releasing.
    pointer(slider, "pointerdown", 500);
    pointer(slider, "pointermove", 500);
    expect(screen.getByText("1:40")).toBeTruthy();
    expect(onSeek).not.toHaveBeenCalled();
  });
});
