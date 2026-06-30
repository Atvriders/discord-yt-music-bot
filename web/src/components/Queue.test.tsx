// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { Queue } from "./Queue.js";
import type { CurrentItem, QueueItem } from "../types.js";

afterEach(() => cleanup());

// The total-remaining readout is the element carrying the "Total remaining time" title,
// so it can be asserted independently of per-row durations that may share its text.
function totalText(): string {
  return screen.getByTitle("Total remaining time").textContent ?? "";
}

const item = (id: string, durationSec: number | null, title = id): QueueItem => ({
  id,
  meta: { videoId: id, title, channel: "c", durationSec, isLive: false, thumbnailUrl: null },
  requester: { discordUserId: "1", displayName: "dj", avatarUrl: "", source: "web" },
  addedAt: 0,
  audio: null,
});

const current = (positionMs: number, durationMs: number): CurrentItem => ({
  ...item("cur", durationMs / 1000),
  positionMs,
  durationMs,
});

const noop = () => {};

describe("Queue power tools", () => {
  it("renders a Shuffle button that calls onShuffle", () => {
    const onShuffle = vi.fn();
    render(
      <Queue
        items={[item("a", 60), item("b", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={onShuffle}
        onPlayNext={noop}
        onJump={noop}
      />,
    );
    const btn = screen.getByRole("button", { name: /shuffle/i });
    fireEvent.click(btn);
    expect(onShuffle).toHaveBeenCalledTimes(1);
  });

  it("renders a per-row Play next button that calls onPlayNext with the item id", () => {
    const onPlayNext = vi.fn();
    render(
      <Queue
        items={[item("a", 60), item("b", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={onPlayNext}
        onJump={noop}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /play next/i }));
    expect(onPlayNext).toHaveBeenCalledWith("b");
  });

  it("jumps to a track when its row is clicked", () => {
    const onJump = vi.fn();
    render(
      <Queue
        items={[item("a", 60), item("b", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={onJump}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /jump to a, play it now/i }));
    expect(onJump).toHaveBeenCalledWith("a");
  });

  it("shows the total upcoming time plus the remaining of the current track", () => {
    // upcoming: 60 + 120 = 180s; current remaining: 200s - 50s = 150s; total = 330s = 5:30
    render(
      <Queue
        items={[item("a", 60), item("b", 120)]}
        current={current(50_000, 200_000)}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
      />,
    );
    expect(totalText()).toBe("5:30");
  });

  it("sums only the upcoming durations when nothing is playing", () => {
    // 60 + 120 = 180s = 3:00
    render(
      <Queue
        items={[item("a", 60), item("b", 120)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
      />,
    );
    expect(totalText()).toBe("3:00");
  });

  it("treats unknown (null) durations as zero in the total", () => {
    // 60 + (null -> 0) = 60s = 1:00, never NaN/—:—
    render(
      <Queue
        items={[item("a", 60), item("b", null)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
      />,
    );
    expect(totalText()).toBe("1:00");
  });
});

describe("Queue auto-discover toggle", () => {
  it("reflects the autoplay setting as OFF on the switch", () => {
    render(
      <Queue
        items={[item("a", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
        autoplay={false}
        autoplaySource="radio"
        onToggleAutoplay={noop}
      />,
    );
    const sw = screen.getByRole("switch", { name: /auto-discover/i });
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects the autoplay setting as ON on the switch", () => {
    render(
      <Queue
        items={[item("a", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
        autoplay={true}
        autoplaySource="radio"
        onToggleAutoplay={noop}
      />,
    );
    const sw = screen.getByRole("switch", { name: /auto-discover/i });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("flips the setting ON when the switch is clicked while OFF", () => {
    const onToggle = vi.fn();
    render(
      <Queue
        items={[item("a", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
        autoplay={false}
        autoplaySource="radio"
        onToggleAutoplay={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /auto-discover/i }));
    expect(onToggle).toHaveBeenCalledWith({ autoplay: true });
  });

  it("flips the setting OFF when the switch is clicked while ON", () => {
    const onToggle = vi.fn();
    render(
      <Queue
        items={[item("a", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
        autoplay={true}
        autoplaySource="radio"
        onToggleAutoplay={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /auto-discover/i }));
    expect(onToggle).toHaveBeenCalledWith({ autoplay: false });
  });

  it("shows the source picker only when auto-discover is ON and posts a source change", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <Queue
        items={[item("a", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
        autoplay={false}
        autoplaySource="radio"
        onToggleAutoplay={onToggle}
      />,
    );
    // Hidden while off.
    expect(screen.queryByRole("combobox", { name: /auto-discover source/i })).toBeNull();
    rerender(
      <Queue
        items={[item("a", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
        autoplay={true}
        autoplaySource="radio"
        onToggleAutoplay={onToggle}
      />,
    );
    const src = screen.getByRole("combobox", { name: /auto-discover source/i });
    expect((src as HTMLSelectElement).value).toBe("radio");
    fireEvent.change(src, { target: { value: "artist" } });
    expect(onToggle).toHaveBeenCalledWith({ autoplaySource: "artist" });
  });

  it("renders without the toggle when no autoplay props are provided (backwards compatible)", () => {
    render(
      <Queue
        items={[item("a", 60)]}
        current={null}
        onRemove={noop}
        onReorder={noop}
        onShuffle={noop}
        onPlayNext={noop}
        onJump={noop}
      />,
    );
    expect(screen.queryByRole("switch", { name: /auto-discover/i })).toBeNull();
  });
});
