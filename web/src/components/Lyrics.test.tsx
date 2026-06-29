// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { Lyrics } from "./Lyrics.js";
import { api } from "../lib/api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(api, "lyrics");
});

describe("Lyrics", () => {
  it("does not fetch until the panel is opened", () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockResolvedValue({ lyrics: "x", source: "lyrics.ovh" });
    render(<Lyrics guildId="g1" videoId="vid1" />);
    expect(api.lyrics).not.toHaveBeenCalled();
  });

  it("fetches and shows lyrics when the panel is opened", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockResolvedValue({
      lyrics: "line one\nline two",
      source: "lyrics.ovh",
    });
    render(<Lyrics guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => expect(screen.getByText(/line one/)).toBeTruthy());
    expect(screen.getByText(/line two/)).toBeTruthy();
    expect(api.lyrics).toHaveBeenCalledWith("g1");
  });

  it("shows a graceful empty state when no lyrics are found", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockResolvedValue({ lyrics: null, source: "lyrics.ovh" });
    render(<Lyrics guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => expect(screen.getByText(/no lyrics found/i)).toBeTruthy());
  });

  it("shows an error state when the fetch fails", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    render(<Lyrics guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => expect(screen.getByText(/couldn.t load lyrics|no lyrics found/i)).toBeTruthy());
  });

  it("refetches when the track (videoId) changes while open", async () => {
    const m = api.lyrics as ReturnType<typeof vi.fn>;
    m.mockResolvedValueOnce({ lyrics: "first song", source: "lyrics.ovh" });
    const { rerender } = render(<Lyrics guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => expect(screen.getByText(/first song/)).toBeTruthy());

    m.mockResolvedValueOnce({ lyrics: "second song", source: "lyrics.ovh" });
    rerender(<Lyrics guildId="g1" videoId="vid2" />);
    await waitFor(() => expect(screen.getByText(/second song/)).toBeTruthy());
    expect(api.lyrics).toHaveBeenCalledTimes(2);
  });

  it("includes the honest 'not time-synced' note", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockResolvedValue({ lyrics: "la", source: "lyrics.ovh" });
    render(<Lyrics guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => expect(screen.getByText(/la/)).toBeTruthy());
    expect(screen.getByText(/not time-synced|best-effort/i)).toBeTruthy();
  });
});
