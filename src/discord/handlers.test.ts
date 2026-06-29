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
  };
  const youtube = { resolve: vi.fn(), search: vi.fn() };
  const { controller: _c, youtube: _y, ...rest } = overrides;
  return {
    requester,
    requesterChannelId: "A" as string | null,
    botChannelId: null as string | null,
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
});
