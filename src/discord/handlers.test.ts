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
    enqueue: vi.fn(async () => ({ id: "i1" })),
    skip: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
  };
  return {
    controller: controller as never,
    youtube: { resolve: vi.fn(), search: vi.fn() },
    requester,
    requesterChannelId: "A",
    botChannelId: null,
    isAdmin: false,
    searchLimit: 5,
    ...overrides,
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

  it("returns a picker for a search query", async () => {
    const c = ctx();
    c.youtube.search.mockResolvedValue([meta("aaaaaaaaaaa", "A"), meta("bbbbbbbbbbb", "B")]);
    const res = await handleCommand({ kind: "play", input: "daft punk" }, c as never);
    expect(c.youtube.search).toHaveBeenCalledWith("daft punk", 5);
    expect(res.type).toBe("picker");
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

  it("help lists commands", async () => {
    const res = await handleCommand({ kind: "help" }, ctx() as never);
    expect(res).toEqual({ type: "message", content: expect.stringContaining("?play") });
  });
});
