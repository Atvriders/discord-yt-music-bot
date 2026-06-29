// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";
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

  it("tracks the dragged position via pointermove (distinct from the pointerdown position)", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    render(<NowPlaying item={item(0, 200_000)} paused={true} receivedAt={0} canSeek onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: /seek/i });
    // pointerdown at 10% (=20s -> 0:20), then MOVE to 50% (=100s -> 1:40). The display
    // must CHANGE to 1:40, so onPointerMove is load-bearing for this assertion.
    pointer(slider, "pointerdown", 100);
    expect(screen.getByText("0:20")).toBeTruthy();
    pointer(slider, "pointermove", 500);
    expect(screen.getByText("1:40")).toBeTruthy();
    expect(screen.queryByText("0:20")).toBeNull();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("does NOT seek when the scrub is cancelled (pointercancel discards the gesture)", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    render(<NowPlaying item={item(0, 200_000)} paused receivedAt={0} canSeek onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 500);
    pointer(slider, "pointercancel", 500);
    // A cancelled gesture commits no seek and shows no optimistic "seeking…" hold.
    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.queryByTestId("seeking-indicator")).toBeNull();
  });

  it("releases the optimistic hold when the seek fails (onSeek rejects)", async () => {
    stubRect(1000, 0);
    const onSeek = vi.fn().mockRejectedValue(new Error("nope"));
    render(<NowPlaying item={item(10_000, 200_000)} paused receivedAt={100} canSeek onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 500);
    pointer(slider, "pointerup", 500);
    expect(onSeek).toHaveBeenCalledWith(100_000);
    // The rejection drops the hold (no confirming snapshot would ever arrive), so the
    // "seeking…" indicator clears and the bar falls back to the server position (0:10).
    await waitFor(() => expect(screen.queryByTestId("seeking-indicator")).toBeNull());
    expect(screen.getByText("0:10")).toBeTruthy();
  });

  it("clears a stale optimistic hold when the bar loses interactivity (canSeek -> false)", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    const { rerender } = render(
      <NowPlaying item={item(10_000, 200_000)} paused receivedAt={100} canSeek onSeek={onSeek} />,
    );
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 500);
    pointer(slider, "pointerup", 500);
    expect(screen.getByTestId("seeking-indicator")).toBeTruthy();
    // Socket drops to forbidden/closed: canSeek flips false. No confirming snapshot can
    // arrive, so the hold must be released rather than freezing on the target.
    rerender(<NowPlaying item={item(10_000, 200_000)} paused receivedAt={100} canSeek={false} onSeek={onSeek} />);
    expect(screen.queryByTestId("seeking-indicator")).toBeNull();
  });

  it("issues exactly ONE seek on release, not one per pointer-move", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    render(<NowPlaying item={item(0, 200_000)} paused={true} receivedAt={0} canSeek onSeek={onSeek} />);
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 100);
    pointer(slider, "pointermove", 200);
    pointer(slider, "pointermove", 300);
    pointer(slider, "pointermove", 400);
    pointer(slider, "pointermove", 500);
    // Mid-drag: zero server calls.
    expect(onSeek).not.toHaveBeenCalled();
    pointer(slider, "pointerup", 500);
    // Release: a single call with the final target.
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(100_000);
  });

  it("holds the optimistic position after release until the server confirms (no snap-back)", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    // Track currently at 0:10; receivedAt is the snapshot id.
    const { rerender } = render(
      <NowPlaying item={item(10_000, 200_000)} paused={true} receivedAt={100} canSeek onSeek={onSeek} />,
    );
    const slider = screen.getByRole("slider", { name: /seek/i });
    // Scrub to 50% (=100s -> 1:40) and release.
    pointer(slider, "pointerdown", 500);
    pointer(slider, "pointerup", 500);
    expect(onSeek).toHaveBeenCalledWith(100_000);
    // The new WS snapshot has NOT arrived yet: same receivedAt, still old positionMs.
    // The bar must NOT snap back to 0:10 — it holds the seek target (1:40).
    rerender(<NowPlaying item={item(10_000, 200_000)} paused={true} receivedAt={100} canSeek onSeek={onSeek} />);
    expect(screen.getByText("1:40")).toBeTruthy();
    expect(screen.queryByText("0:10")).toBeNull();
    // A "seeking" affordance is shown while we wait for confirmation.
    expect(screen.getByTestId("seeking-indicator")).toBeTruthy();
  });

  it("releases the optimistic hold once the confirming snapshot lands", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    const { rerender } = render(
      <NowPlaying item={item(10_000, 200_000)} paused={true} receivedAt={100} canSeek onSeek={onSeek} />,
    );
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 500);
    pointer(slider, "pointerup", 500);
    // New snapshot arrives (new receivedAt) reflecting the seeked position (1:40).
    rerender(<NowPlaying item={item(100_000, 200_000)} paused={true} receivedAt={200} canSeek onSeek={onSeek} />);
    expect(screen.getByText("1:40")).toBeTruthy();
    // Hold released: seeking affordance gone, bar follows the server again.
    expect(screen.queryByTestId("seeking-indicator")).toBeNull();
  });

  it("follows the new server position after a confirmed seek, not the stale target", () => {
    stubRect(1000, 0);
    const onSeek = vi.fn();
    const { rerender } = render(
      <NowPlaying item={item(10_000, 200_000)} paused={true} receivedAt={100} canSeek onSeek={onSeek} />,
    );
    const slider = screen.getByRole("slider", { name: /seek/i });
    pointer(slider, "pointerdown", 500);
    pointer(slider, "pointerup", 500); // target 1:40
    // Confirming snapshot, then a later snapshot the server moved on to (1:45).
    rerender(<NowPlaying item={item(100_000, 200_000)} paused={true} receivedAt={200} canSeek onSeek={onSeek} />);
    rerender(<NowPlaying item={item(105_000, 200_000)} paused={true} receivedAt={300} canSeek onSeek={onSeek} />);
    expect(screen.getByText("1:45")).toBeTruthy();
  });
});
