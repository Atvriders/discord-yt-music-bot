// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { History } from "./History.js";
import type { QueueItem } from "../types.js";

afterEach(() => cleanup());

const item = (videoId: string, title = videoId): QueueItem => ({
  id: `i-${videoId}`,
  meta: { videoId, title, channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null },
  requester: { discordUserId: "1", displayName: "dj", avatarUrl: "", source: "web" },
  addedAt: 0,
  audio: null,
});

describe("History", () => {
  it("renders an empty state when nothing has played", () => {
    render(<History history={[]} onRequeue={vi.fn()} />);
    expect(screen.getByText(/nothing has played/i)).toBeTruthy();
  });

  it("lists tracks most-recent first (history is oldest-first) and caps at 10", () => {
    // 12 finished tracks oldest-first: aaa...0 finished first, ...11 most recent.
    const history = Array.from({ length: 12 }, (_, i) => item(`v${i}`, `Track ${i}`));
    render(<History history={history} onRequeue={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    // Most recent (Track 11) is first; the two oldest (0,1) are dropped by the cap.
    expect(within(rows[0]!).getByText("Track 11")).toBeTruthy();
    expect(screen.queryByText("Track 0")).toBeNull();
    expect(screen.queryByText("Track 1")).toBeNull();
    expect(screen.getByText("Track 2")).toBeTruthy();
  });

  it("re-queues a track by its videoId on click", () => {
    const onRequeue = vi.fn();
    render(<History history={[item("abc12345678", "Song A")]} onRequeue={onRequeue} />);
    fireEvent.click(screen.getByRole("button", { name: /re-queue song a/i }));
    expect(onRequeue).toHaveBeenCalledWith("abc12345678");
  });

  it("disables re-queue buttons when disabled (no voice target)", () => {
    const onRequeue = vi.fn();
    render(<History history={[item("abc12345678", "Song A")]} onRequeue={onRequeue} disabled />);
    const btn = screen.getByRole("button", { name: /re-queue song a/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onRequeue).not.toHaveBeenCalled();
  });
});
