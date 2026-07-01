// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
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
    render(<Lyrics botId="b1" guildId="g1" videoId="vid1" />);
    expect(api.lyrics).not.toHaveBeenCalled();
  });

  it("fetches and shows lyrics when the panel is opened", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockResolvedValue({
      lyrics: "line one\nline two",
      source: "lyrics.ovh",
    });
    render(<Lyrics botId="b1" guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => screen.getByText(/line one/));
    screen.getByText(/line two/);
    expect(api.lyrics).toHaveBeenCalledWith("b1", "g1");
  });

  it("shows a graceful empty state when no lyrics are found", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockResolvedValue({ lyrics: null, source: "lyrics.ovh" });
    render(<Lyrics botId="b1" guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => screen.getByText(/no lyrics found/i));
  });

  it("shows an error state when the fetch fails", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    render(<Lyrics botId="b1" guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    // Error-specific text (NOT the empty state). The wildcard matches the typographic
    // apostrophe (U+2019) the component renders in "Couldn't".
    await waitFor(() => expect(screen.getByText(/couldn.t load lyrics/i)).toBeTruthy());
    // The Retry button is the discriminator: only the error state renders it, so this
    // assertion can never be satisfied by the empty state.
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("refetches when the track (videoId) changes while open", async () => {
    const m = api.lyrics as ReturnType<typeof vi.fn>;
    m.mockResolvedValueOnce({ lyrics: "first song", source: "lyrics.ovh" });
    const { rerender } = render(<Lyrics botId="b1" guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => screen.getByText(/first song/));

    m.mockResolvedValueOnce({ lyrics: "second song", source: "lyrics.ovh" });
    rerender(<Lyrics botId="b1" guildId="g1" videoId="vid2" />);
    await waitFor(() => screen.getByText(/second song/));
    expect(api.lyrics).toHaveBeenCalledTimes(2);
  });

  it("discards a stale in-flight response when the track changes (reqIdRef guard)", async () => {
    const m = api.lyrics as ReturnType<typeof vi.fn>;
    // Capture both resolvers so we control resolution ORDER independently of issue order.
    let resolve1!: (v: { lyrics: string; source: string }) => void;
    let resolve2!: (v: { lyrics: string; source: string }) => void;
    m.mockReturnValueOnce(new Promise((r) => { resolve1 = r; }));
    m.mockReturnValueOnce(new Promise((r) => { resolve2 = r; }));

    const { rerender } = render(<Lyrics botId="b1" guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i })); // request 1 in flight (held)
    rerender(<Lyrics botId="b1" guildId="g1" videoId="vid2" />); // request 2 in flight (held)

    // Resolve the SECOND (newer) request first, then the FIRST (stale) request.
    await act(async () => { resolve2({ lyrics: "second song", source: "lyrics.ovh" }); });
    await act(async () => { resolve1({ lyrics: "first song", source: "lyrics.ovh" }); });

    // Only the newer track's lyrics are shown; the stale earlier response is discarded.
    await waitFor(() => screen.getByText(/second song/));
    expect(screen.queryByText(/first song/)).toBeNull();
  });

  it("includes the honest 'not time-synced' note", async () => {
    (api.lyrics as ReturnType<typeof vi.fn>).mockResolvedValue({ lyrics: "la", source: "lyrics.ovh" });
    render(<Lyrics botId="b1" guildId="g1" videoId="vid1" />);
    fireEvent.click(screen.getByRole("button", { name: /lyrics/i }));
    await waitFor(() => screen.getByText(/la/));
    screen.getByText(/not time-synced|best-effort/i);
  });
});
