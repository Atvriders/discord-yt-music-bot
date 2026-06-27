// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AddBar } from "./AddBar.js";
import type { TrackMeta } from "../types.js";

afterEach(() => cleanup());

const track = (id: string): TrackMeta => ({
  videoId: id, title: `Title ${id}`, channel: "Chan", durationSec: 120, isLive: false, thumbnailUrl: null,
});

function box(): HTMLInputElement {
  return screen.getByLabelText(/add a track/i) as HTMLInputElement;
}

describe("AddBar", () => {
  it("BUG 6: shows 'No matches' (not a stranded empty picker) when a search returns no candidates", async () => {
    const onPlay = vi.fn(async () => ({ candidates: [] as TrackMeta[] }));
    render(<AddBar onPlay={onPlay} onPick={() => {}} />);
    fireEvent.change(box(), { target: { value: "nothing matches" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(screen.getByText(/No matches — try a different search\./i)).toBeTruthy());
    // The "Pick the exact track" header is NOT rendered for an empty list.
    expect(screen.queryByText(/Pick the exact track/i)).toBeNull();
  });

  it("BUG 6: renders the picker when candidates are present", async () => {
    const onPlay = vi.fn(async () => ({ candidates: [track("aaaaaaaaaaa"), track("bbbbbbbbbbb")] }));
    const onPick = vi.fn();
    render(<AddBar onPlay={onPlay} onPick={onPick} />);
    fireEvent.change(box(), { target: { value: "daft punk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(screen.getByText(/Pick the exact track/i)).toBeTruthy());
    expect(screen.queryByText(/No matches/i)).toBeNull();
    fireEvent.click(screen.getByText("Title aaaaaaaaaaa"));
    expect(onPick).toHaveBeenCalledWith("aaaaaaaaaaa");
  });

  it("disables the input and button while busy (no voice channel target)", () => {
    render(<AddBar onPlay={async () => ({ candidates: null })} onPick={() => {}} busy />);
    expect(box().disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Queue it/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a link queue (null candidates) renders neither the picker nor a no-matches message", async () => {
    const onPlay = vi.fn(async () => ({ candidates: null }));
    render(<AddBar onPlay={onPlay} onPick={() => {}} />);
    fireEvent.change(box(), { target: { value: "https://youtu.be/abcdefghijk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(box().value).toBe(""));
    expect(screen.queryByText(/Pick the exact track/i)).toBeNull();
    expect(screen.queryByText(/No matches/i)).toBeNull();
  });
});
