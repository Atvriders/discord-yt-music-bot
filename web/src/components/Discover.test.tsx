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
    render(<Discover onSearch={vi.fn()} onPick={vi.fn()} />);
    // Presets hidden until expanded.
    expect(screen.queryByText("Lofi")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    // Every genre + mood preset is now visible.
    for (const p of [...GENRE_PRESETS, ...MOOD_PRESETS]) {
      expect(screen.getByRole("button", { name: p.label })).toBeTruthy();
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
    render(<Discover onSearch={vi.fn()} onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    expect(screen.getByText(/not a recommendation engine/i)).toBeTruthy();
  });

  it("runs the preset query through onSearch and shows the picker", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: [TRACK] });
    render(<Discover onSearch={onSearch} onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Lofi" }));

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    const lofi = GENRE_PRESETS.find((p) => p.label === "Lofi")!;
    expect(onSearch).toHaveBeenCalledWith(lofi.query);
    await waitFor(() => expect(screen.getByText("Some Lofi Track")).toBeTruthy());
    expect(screen.getByText(/pick the exact track/i)).toBeTruthy();
  });

  it("queues the chosen track via onPick and clears the picker", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: [TRACK] });
    const onPick = vi.fn();
    render(<Discover onSearch={onSearch} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Workout" }));

    await waitFor(() => expect(screen.getByText("Some Lofi Track")).toBeTruthy());
    fireEvent.click(screen.getByText("Some Lofi Track"));
    expect(onPick).toHaveBeenCalledWith("abc123");
    await waitFor(() => expect(screen.queryByText("Some Lofi Track")).toBeNull());
  });

  it("uses a mood preset query when a mood is clicked", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: [] });
    render(<Discover onSearch={onSearch} onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));

    const focus = MOOD_PRESETS.find((p) => p.label === "Focus")!;
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith(focus.query));
    await waitFor(() => expect(screen.getByText(/no tracks found/i)).toBeTruthy());
  });

  it("handles a non-search result (null candidates) without showing a picker", async () => {
    const onSearch = vi.fn().mockResolvedValue({ candidates: null });
    render(<Discover onSearch={onSearch} onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    fireEvent.click(screen.getByRole("button", { name: "Jazz" }));

    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/pick the exact track/i)).toBeNull();
    expect(screen.queryByText(/no tracks found/i)).toBeNull();
  });
});
