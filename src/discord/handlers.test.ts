import { describe, it, expect, vi } from "vitest";
import { handleCommand } from "./handlers.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import type { Requester, TrackMeta } from "../types/index.js";

const requester: Requester = {
  discordUserId: "1",
  displayName: "u",
  avatarUrl: "a",
  source: "discord",
};
const meta = (id: string, title = id): TrackMeta => ({
  videoId: id,
  title,
  channel: "c",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
});

function ctx(overrides: Partial<Parameters<typeof handleCommand>[1]> = {}) {
  const controller = {
    ensureConnected: vi.fn(async () => {}),
    moveTo: vi.fn(async () => {}),
    enqueue: vi.fn(async () => ({ id: "i1" })),
    skip: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
    setVolume: vi.fn((pct: number) => ({ volume: pct })),
    updateSettings: vi.fn((patch: Record<string, unknown>) => ({
      commandChannelId: null,
      ...patch,
    })),
  };
  const youtube = { resolve: vi.fn(), search: vi.fn(), resolveUrl: vi.fn() };
  const { controller: _c, youtube: _y, ...rest } = overrides;
  return {
    requester,
    requesterChannelId: "A" as string | null,
    botChannelId: null as string | null,
    channelId: "text-chan-1" as string,
    isAdmin: false,
    searchLimit: 5,
    ...rest,
    // Keep the literal mock types (so .mockResolvedValue / .mockReturnValue resolve)
    // by excluding these from the Partial-widened spread above.
    controller,
    youtube,
  };
}

describe("handleCommand — play", () => {
  it("queues an exact URL", async () => {
    const c = ctx();
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa", "Song"));
    const res = await handleCommand(
      { kind: "play", input: "https://youtu.be/aaaaaaaaaaa" },
      c as never,
    );
    expect(c.youtube.resolve).toHaveBeenCalledWith("aaaaaaaaaaa");
    expect(c.controller.ensureConnected).toHaveBeenCalledWith("A");
    expect(c.controller.enqueue).toHaveBeenCalled();
    expect(res).toEqual({ type: "message", content: expect.stringContaining("Song") });
  });

  it("rejects a non-YouTube URL without resolving", async () => {
    const c = ctx();
    const res = await handleCommand({ kind: "play", input: "https://vimeo.com/1" }, c as never);
    expect(c.youtube.resolve).not.toHaveBeenCalled();
    expect(res.type).toBe("message");
  });

  it("queues a SoundCloud link via resolveUrl and labels the source", async () => {
    const c = ctx();
    c.youtube.resolveUrl.mockResolvedValue(meta("sc_9", "SC Jam"));
    const res = await handleCommand(
      { kind: "play", input: "https://soundcloud.com/artist/sc-jam" },
      c as never,
    );
    expect(c.youtube.resolveUrl).toHaveBeenCalledWith("https://soundcloud.com/artist/sc-jam");
    expect(c.youtube.resolve).not.toHaveBeenCalled();
    expect(c.controller.enqueue).toHaveBeenCalled();
    expect(res).toEqual({
      type: "message",
      content: expect.stringMatching(/SC Jam.*SoundCloud/s),
    });
  });

  it("resolves a Spotify link to a YouTube match and plays it", async () => {
    const spotify = vi.fn(async () => "Feel Good Inc Gorillaz");
    const c = ctx({ spotify });
    c.youtube.search.mockResolvedValue([meta("aaaaaaaaaaa", "Feel Good Inc")]);
    const res = await handleCommand(
      { kind: "play", input: "https://open.spotify.com/track/abc" },
      c as never,
    );
    expect(spotify).toHaveBeenCalledWith("https://open.spotify.com/track/abc");
    expect(c.youtube.search).toHaveBeenCalledWith("Feel Good Inc Gorillaz", 1);
    expect(c.controller.enqueue).toHaveBeenCalled();
    expect(res).toEqual({
      type: "message",
      content: expect.stringMatching(/Feel Good Inc.*Spotify/s),
    });
  });

  it("reports when a Spotify track can't be resolved", async () => {
    const spotify = vi.fn(async () => null);
    const c = ctx({ spotify });
    const res = await handleCommand(
      { kind: "play", input: "https://open.spotify.com/track/abc" },
      c as never,
    );
    expect(c.youtube.search).not.toHaveBeenCalled();
    expect(c.controller.enqueue).not.toHaveBeenCalled();
    expect(res.type).toBe("message");
  });

  it("reports when a Spotify track has no YouTube match", async () => {
    const spotify = vi.fn(async () => "obscure track nobody uploaded");
    const c = ctx({ spotify });
    c.youtube.search.mockResolvedValue([]);
    const res = await handleCommand(
      { kind: "play", input: "https://open.spotify.com/track/abc" },
      c as never,
    );
    expect(c.controller.enqueue).not.toHaveBeenCalled();
    expect(res).toEqual({ type: "message", content: expect.stringMatching(/no youtube match/i) });
  });

  it("surfaces a friendly message on a YtError", async () => {
    const c = ctx();
    c.youtube.resolve.mockRejectedValue(new YtError(YtErrorKind.Private, "private"));
    const res = await handleCommand(
      { kind: "play", input: "https://youtu.be/aaaaaaaaaaa" },
      c as never,
    );
    expect(res).toEqual({ type: "message", content: expect.stringMatching(/private/i) });
    expect(c.controller.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to queue when the requester is not in a voice channel", async () => {
    const c = ctx({ requesterChannelId: null });
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa"));
    const res = await handleCommand(
      { kind: "play", input: "https://youtu.be/aaaaaaaaaaa" },
      c as never,
    );
    expect(c.controller.enqueue).not.toHaveBeenCalled();
    expect(res.type).toBe("message");
  });

  it("admin in a different channel calls moveTo, not ensureConnected", async () => {
    const c = ctx({ requesterChannelId: "A", botChannelId: "B", isAdmin: true });
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa", "Song"));
    const res = await handleCommand(
      { kind: "play", input: "https://youtu.be/aaaaaaaaaaa" },
      c as never,
    );
    expect(c.controller.moveTo).toHaveBeenCalledWith("A");
    expect(c.controller.ensureConnected).not.toHaveBeenCalled();
    expect(c.controller.enqueue).toHaveBeenCalled();
    expect(res).toEqual({ type: "message", content: expect.stringContaining("Song") });
  });

  it("surfaces a concrete message when ensureConnected throws (e.g. missing CONNECT perm)", async () => {
    const c = ctx();
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa", "Song"));
    c.controller.ensureConnected = vi.fn(async () => {
      throw new Error("Missing Permissions");
    });
    const res = await handleCommand(
      { kind: "play", input: "https://youtu.be/aaaaaaaaaaa" },
      c as never,
    );
    expect(res).toEqual({
      type: "message",
      content: expect.stringContaining("Couldn't join that voice channel"),
    });
    // A failed join must NOT proceed to enqueue.
    expect(c.controller.enqueue).not.toHaveBeenCalled();
  });

  it("surfaces a concrete message when moveTo throws (admin cross-channel join failure)", async () => {
    const c = ctx({ requesterChannelId: "A", botChannelId: "B", isAdmin: true });
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa", "Song"));
    c.controller.moveTo = vi.fn(async () => {
      throw new Error("connection failed");
    });
    const res = await handleCommand(
      { kind: "play", input: "https://youtu.be/aaaaaaaaaaa" },
      c as never,
    );
    expect(res).toEqual({
      type: "message",
      content: expect.stringContaining("Couldn't join that voice channel"),
    });
    expect(c.controller.enqueue).not.toHaveBeenCalled();
  });

  it("returns a picker for a search query", async () => {
    const c = ctx();
    c.youtube.search.mockResolvedValue([meta("aaaaaaaaaaa", "A"), meta("bbbbbbbbbbb", "B")]);
    const res = await handleCommand({ kind: "play", input: "daft punk" }, c as never);
    expect(c.youtube.search).toHaveBeenCalledWith("daft punk", 5);
    expect(res.type).toBe("picker");
  });

  it("surfaces a friendly message when search throws a YtError", async () => {
    const c = ctx();
    c.youtube.search.mockRejectedValue(new YtError(YtErrorKind.Unknown, "boom"));
    const res = await handleCommand({ kind: "play", input: "daft punk" }, c as never);
    expect(res).toEqual({
      type: "message",
      content: expect.stringContaining(YtErrorKind.Unknown),
    });
  });

  it("surfaces a generic message when search throws a non-YtError", async () => {
    const c = ctx();
    c.youtube.search.mockRejectedValue(new SyntaxError("Unexpected end of JSON input"));
    const res = await handleCommand({ kind: "play", input: "daft punk" }, c as never);
    expect(res).toEqual({ type: "message", content: expect.stringContaining("Search failed") });
  });

  it("surfaces the YtError message when enqueue rejects (max-track-length guard)", async () => {
    const c = ctx();
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa", "Song"));
    c.controller.enqueue = vi.fn(async () => {
      throw new YtError(YtErrorKind.TooLong, "Too long — max 2h");
    });
    const res = await handleCommand(
      { kind: "play", input: "https://youtu.be/aaaaaaaaaaa" },
      c as never,
    );
    expect(res).toEqual({ type: "message", content: expect.stringContaining("Too long") });
  });

  it("re-throws a non-YtError raised by enqueue", async () => {
    const c = ctx();
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa", "Song"));
    c.controller.enqueue = vi.fn(async () => {
      throw new Error("kaboom");
    });
    await expect(
      handleCommand({ kind: "play", input: "https://youtu.be/aaaaaaaaaaa" }, c as never),
    ).rejects.toThrow(/kaboom/);
  });
});

describe("handleCommand — controls", () => {
  it("skip/pause/resume/stop call the controller", async () => {
    const c = ctx();
    expect((await handleCommand({ kind: "skip" }, c as never)).type).toBe("message");
    expect(c.controller.skip).toHaveBeenCalled();
    await handleCommand({ kind: "pause" }, c as never);
    expect(c.controller.pause).toHaveBeenCalled();
    await handleCommand({ kind: "resume" }, c as never);
    expect(c.controller.resume).toHaveBeenCalled();
    await handleCommand({ kind: "stop" }, c as never);
    expect(c.controller.stop).toHaveBeenCalled();
  });

  it("volume calls controller.setVolume and reports the new percentage", async () => {
    const c = ctx();
    const res = await handleCommand({ kind: "volume", percent: 150 }, c as never);
    expect(c.controller.setVolume).toHaveBeenCalledWith(150);
    expect(res).toEqual({ type: "message", content: expect.stringContaining("150%") });
  });

  it("remove maps a 1-based index to the upcoming item id", async () => {
    const c = ctx();
    c.controller.snapshot.mockReturnValue({
      current: null,
      upcoming: [
        { id: "i1", meta: { title: "Track One" } },
        { id: "i2", meta: { title: "Track Two" } },
      ],
      history: [],
    } as never);
    const res = await handleCommand({ kind: "remove", index: 2 }, c as never);
    expect(c.controller.remove).toHaveBeenCalledWith("i2");
    expect(res).toEqual({ type: "message", content: expect.stringContaining("Track Two") });
  });

  it("does NOT claim removal when the item already left the queue (TOCTOU)", async () => {
    const c = ctx();
    c.controller.snapshot.mockReturnValue({
      current: null,
      upcoming: [{ id: "i1", meta: { title: "Track One" } }],
      history: [],
    } as never);
    // The track advanced between snapshot() and remove() — remove() returns false.
    c.controller.remove = vi.fn(async () => false);
    const res = await handleCommand({ kind: "remove", index: 1 }, c as never);
    expect(c.controller.remove).toHaveBeenCalledWith("i1");
    expect(res).toEqual({ type: "message", content: expect.stringContaining("already played") });
    if (res.type === "message") expect(res.content).not.toContain("Removed");
  });

  it("help lists commands", async () => {
    const res = await handleCommand({ kind: "help" }, ctx() as never);
    expect(res).toEqual({ type: "message", content: expect.stringContaining("?play") });
  });

  it("history lists recently played, most-recent first, capped at 10", async () => {
    const c = ctx();
    // 12 finished tracks, oldest-first (as the queue stores history).
    const history = Array.from({ length: 12 }, (_, i) => ({
      id: `h${i}`,
      meta: { title: `Track ${i}` },
      requester: { displayName: "dj" },
    }));
    c.controller.snapshot.mockReturnValue({ current: null, upcoming: [], history } as never);
    const res = await handleCommand({ kind: "history" }, c as never);
    if (res.type !== "message") throw new Error("expected message");
    // Most recent (Track 11) is listed first; only the last 10 are shown (Track 2..11).
    expect(res.content).toContain("1. Track 11");
    expect(res.content).toContain("Track 2");
    expect(res.content).not.toContain("Track 0");
  });

  it("history reports nothing when no tracks have played", async () => {
    const c = ctx();
    c.controller.snapshot.mockReturnValue({ current: null, upcoming: [], history: [] } as never);
    const res = await handleCommand({ kind: "history" }, c as never);
    expect(res).toEqual({ type: "message", content: expect.stringContaining("No history") });
  });
});

describe("handleCommand — queue/np", () => {
  const reqItem = (id: string, title: string) => ({
    id,
    meta: { title },
    requester: { displayName: "dj" },
  });

  it("np reports nothing playing when current is null", async () => {
    const c = ctx();
    c.controller.snapshot.mockReturnValue({ current: null, upcoming: [], history: [] } as never);
    const res = await handleCommand({ kind: "np" }, c as never);
    expect(res).toEqual({
      type: "message",
      content: expect.stringContaining("Nothing is playing"),
    });
  });

  it("np shows the current track title and requester", async () => {
    const c = ctx();
    c.controller.snapshot.mockReturnValue({
      current: { id: "cur", meta: { title: "Now Song" }, requester: { displayName: "Alice" } },
      upcoming: [],
      history: [],
    } as never);
    const res = await handleCommand({ kind: "np" }, c as never);
    if (res.type !== "message") throw new Error("expected message");
    expect(res.content).toContain("Now Song");
    expect(res.content).toContain("Alice");
  });

  it("queue says nothing playing with no current and no upcoming, and omits Up next", async () => {
    const c = ctx();
    c.controller.snapshot.mockReturnValue({ current: null, upcoming: [], history: [] } as never);
    const res = await handleCommand({ kind: "queue" }, c as never);
    if (res.type !== "message") throw new Error("expected message");
    expect(res.content).toContain("Nothing playing.");
    expect(res.content).not.toContain("Up next");
  });

  it("queue lists exactly 10 upcoming items with no overflow line", async () => {
    const c = ctx();
    const upcoming = Array.from({ length: 10 }, (_, i) => reqItem(`u${i}`, `Track ${i + 1}`));
    c.controller.snapshot.mockReturnValue({
      current: { id: "cur", meta: { title: "Cur" }, requester: { displayName: "dj" } },
      upcoming,
      history: [],
    } as never);
    const res = await handleCommand({ kind: "queue" }, c as never);
    if (res.type !== "message") throw new Error("expected message");
    expect(res.content).toContain("1. Track 1");
    expect(res.content).toContain("10. Track 10");
    expect(res.content).not.toContain("…and");
  });

  it("queue caps at 10 and appends `…and N more` for 11+ upcoming", async () => {
    const c = ctx();
    const upcoming = Array.from({ length: 13 }, (_, i) => reqItem(`u${i}`, `Track ${i + 1}`));
    c.controller.snapshot.mockReturnValue({
      current: { id: "cur", meta: { title: "Cur" }, requester: { displayName: "dj" } },
      upcoming,
      history: [],
    } as never);
    const res = await handleCommand({ kind: "queue" }, c as never);
    if (res.type !== "message") throw new Error("expected message");
    expect(res.content).toContain("10. Track 10");
    expect(res.content).not.toContain("11. Track 11");
    expect(res.content).toContain("…and 3 more");
  });
});

describe("handleCommand — channel restriction", () => {
  it("admin `?channel` set restricts commands to the message's channel and confirms", async () => {
    const c = ctx({ isAdmin: true, channelId: "chan-42" });
    const res = await handleCommand({ kind: "channel", mode: "set" }, c as never);
    expect(c.controller.updateSettings).toHaveBeenCalledWith({ commandChannelId: "chan-42" });
    expect(res.type).toBe("message");
    if (res.type === "message") {
      expect(res.content).toContain("<#chan-42>");
      expect(res.content).toMatch(/restricted/i);
    }
  });

  it("admin `?channel off` clears the restriction (commandChannelId null) and confirms", async () => {
    const c = ctx({ isAdmin: true, channelId: "chan-42" });
    const res = await handleCommand({ kind: "channel", mode: "off" }, c as never);
    expect(c.controller.updateSettings).toHaveBeenCalledWith({ commandChannelId: null });
    expect(res.type).toBe("message");
    if (res.type === "message") expect(res.content).toMatch(/removed|cleared/i);
  });

  it("non-admin `?channel` is rejected and never touches settings", async () => {
    const c = ctx({ isAdmin: false, channelId: "chan-42" });
    const res = await handleCommand({ kind: "channel", mode: "set" }, c as never);
    expect(c.controller.updateSettings).not.toHaveBeenCalled();
    expect(res.type).toBe("message");
    if (res.type === "message") expect(res.content).toMatch(/admin/i);
  });

  it("non-admin `?channel off` is also rejected", async () => {
    const c = ctx({ isAdmin: false, channelId: "chan-42" });
    const res = await handleCommand({ kind: "channel", mode: "off" }, c as never);
    expect(c.controller.updateSettings).not.toHaveBeenCalled();
    expect(res.type).toBe("message");
  });
});
