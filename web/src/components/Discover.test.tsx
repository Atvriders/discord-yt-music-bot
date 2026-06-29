// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Discover, GENRE_PRESETS, MOOD_PRESETS } from "./Discover.js";
import type { TrackMeta } from "../types.js";

afterEach(() => cleanup());

const TRACK: TrackMeta = {
  videoId: "abc123",
  title: "Some Lofi Track",
  channel: "Lofi Channel",
  durationSec: 120,
  isLive: false,
  thumbnailUrl: null,
};

describe("Discover", () => {
  it("is collapsed by default and reveals presets when opened", () => {
    render(<Discover onSearch={vi.fn()} onQueueAll={vi.fn()} />);
    // Presets hidden until expanded.
    expect(screen.queryByText("Lofi")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    // Every genre + mood preset is now visible (getByRole throws if any is missing).
    for (const p of [...GENRE_PRESETS, ...MOOD_PRESETS]) {
      screen.getByRole("button", { name: p.label });
    }
  });

  it("offers the expected genre and mood presets", () => {
    expect(GENRE_PRESETS.map((p) => p.label)).toEqual([
      "Lofi", "Rock", "Hip-Hop", "Electronic", "Jazz", "Classical", "Pop", "Metal",
    ]);
    expect(MOOD_PRESETS.map((p) => p.label)).toEqual([
      "Chill", "Focus", "Workout", "Party", "Sleep", "Happy",
    ]);
  });

  it("makes clear it is preset/search-based, not a recommendation engine", () => {
    render(<Discover onSearch={vi.fn()} onQueueAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    screen.getByText(/not a recommendation engine/i);
  });

  it("runs the preset query through onSearch and shows the picker", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: [TRACK] });
    render(<Discover onSearch={onSearch} onQueueAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Lofi" }));

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    const lofi = GENRE_PRESETS.find((p) => p.label === "Lofi")!;
    expect(onSearch).toHaveBeenCalledWith(lofi.query);
    await waitFor(() => screen.getByText("Some Lofi Track"));
    screen.getByText(/pick the exact track/i);
  });

  it("selects then queues the chosen track via onQueueAll and clears the picker", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: [TRACK] });
    const onQueueAll = vi.fn(async () => true);
    render(<Discover onSearch={onSearch} onQueueAll={onQueueAll} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Workout" }));

    await waitFor(() => screen.getByText("Some Lofi Track"));
    // Multi-select model: toggle the row, then queue.
    fireEvent.click(screen.getByText("Some Lofi Track"));
    expect(onQueueAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /queue 1 selected/i }));
    expect(onQueueAll).toHaveBeenCalledWith(["abc123"]);
    await waitFor(() => expect(screen.queryByText("Some Lofi Track")).toBeNull());
  });

  it("queues MULTIPLE selected candidates in candidate order", async () => {
    const a: TrackMeta = { ...TRACK, videoId: "aaa", title: "Track A" };
    const b: TrackMeta = { ...TRACK, videoId: "bbb", title: "Track B" };
    const onSearch = vi.fn().mockResolvedValue({ candidates: [a, b] });
    const onQueueAll = vi.fn(async () => true);
    render(<Discover onSearch={onSearch} onQueueAll={onQueueAll} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Lofi" }));

    await waitFor(() => screen.getByText("Track A"));
    fireEvent.click(screen.getByText("Track B"));
    fireEvent.click(screen.getByText("Track A"));
    fireEvent.click(screen.getByRole("button", { name: /queue 2 selected/i }));
    expect(onQueueAll).toHaveBeenCalledWith(["aaa", "bbb"]);
  });

  it("uses a mood preset query when a mood is clicked", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: [] });
    render(<Discover onSearch={onSearch} onQueueAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    const focus = MOOD_PRESETS.find((p) => p.label === "Focus")!;
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith(focus.query));
    await waitFor(() => screen.getByText(/no tracks found/i));
  });

  it("handles a non-search result (null candidates) without showing a picker", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: null });
    render(<Discover onSearch={onSearch} onQueueAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Jazz" }));

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/pick the exact track/i)).toBeNull();
    expect(screen.queryByText(/no tracks found/i)).toBeNull();
  });

  it("clears the active-pill highlight when a search returns zero results", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: [] });
    render(<Discover onSearch={onSearch} onQueueAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    const lofi = screen.getByRole("button", { name: "Lofi" });
    fireEvent.click(lofi);
    await waitFor(() => screen.getByText(/no tracks found/i));
    // The preset is no longer marked active (aria-pressed back to false) — no lingering
    // highlight with nothing to show.
    expect(lofi.getAttribute("aria-pressed")).toBe("false");
  });

  it("clears the active-pill highlight on a null (non-search/link) result", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: null });
    render(<Discover onSearch={onSearch} onQueueAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    const jazz = screen.getByRole("button", { name: "Jazz" });
    fireEvent.click(jazz);
    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(jazz.getAttribute("aria-pressed")).toBe("false"));
  });
});
