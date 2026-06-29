import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  NowPlayingManager,
  buildNowPlayingPayload,
  buildStoppedPayload,
  decodeNpAction,
  encodeNpAction,
  type NpGateway,
  type NpPayload,
} from "./np-message.js";
import type { ControllerSnapshot } from "../orchestrator/index.js";
import type { QueueItem } from "../types/index.js";

function item(id: string, title = id, durationSec: number | null = 213): QueueItem {
  return {
    id: `q-${id}`,
    meta: {
      videoId: id,
      title,
      channel: "ch",
      durationSec,
      isLive: false,
      thumbnailUrl: `http://t/${id}`,
    },
    requester: { discordUserId: "1", displayName: "Alice", avatarUrl: "a", source: "discord" },
    addedAt: 0,
    audio: null,
  };
}

function snap(overrides: Partial<ControllerSnapshot> = {}): ControllerSnapshot {
  const cur = item("aaa", "Song A");
  return {
    current: { ...cur, positionMs: 0, durationMs: 213000 },
    upcoming: [],
    history: [],
    paused: false,
    idleTimeoutSec: 300,
    crossfadeSec: 0,
    normalizeLoudness: false,
    repeat: "off",
    autoplay: false,
    autoplaySource: "radio",
    maxTrackDurationSec: 0,
    volume: 100,
    fx: "none",
    ...overrides,
  };
}

const idleSnap = (): ControllerSnapshot => snap({ current: null });

describe("np customId codec", () => {
  it("round-trips every action", () => {
    for (const a of ["pauseresume", "skip", "stop", "shuffle"] as const) {
      expect(decodeNpAction(encodeNpAction(a))).toBe(a);
    }
  });
  it("rejects foreign and malformed ids", () => {
    expect(decodeNpAction("pick:abc")).toBeNull();
    expect(decodeNpAction("np:bogus")).toBeNull();
    expect(decodeNpAction("np:")).toBeNull();
    expect(decodeNpAction("nope")).toBeNull();
  });
});

describe("buildNowPlayingPayload", () => {
  it("renders title, thumbnail, requester, duration and the four control buttons", () => {
    const p = buildNowPlayingPayload(snap({ upcoming: [item("bbb"), item("ccc")] }));
    const embed = p.embeds[0]!;
    expect(embed.title).toBe("Song A");
    expect(embed.thumbnail?.url).toBe("http://t/aaa");
    const fields = embed.fields ?? [];
    expect(fields.find((f) => f.name === "Requested by")?.value).toBe("Alice");
    expect(fields.find((f) => f.name === "Duration")?.value).toBe("3:33");
    expect(fields.find((f) => f.name === "Up next")?.value).toBe("2 tracks");

    const row = p.components[0]!;
    const ids = row.components.map((c) => (c as { custom_id: string }).custom_id);
    expect(ids).toEqual([
      encodeNpAction("pauseresume"),
      encodeNpAction("skip"),
      encodeNpAction("stop"),
      encodeNpAction("shuffle"),
    ]);
  });

  it("shows a Resume label when paused", () => {
    const p = buildNowPlayingPayload(snap({ paused: true }));
    expect(p.embeds[0]!.author?.name).toBe("Paused");
    const first = p.components[0]!.components[0] as { label?: string };
    expect(first.label).toBe("Resume");
  });

  it("formats hour-long durations", () => {
    const cur = item("aaa", "Long", 3725);
    const p = buildNowPlayingPayload(
      snap({ current: { ...cur, positionMs: 0, durationMs: 3725000 } }),
    );
    expect(p.embeds[0]!.fields?.find((f) => f.name === "Duration")?.value).toBe("1:02:05");
  });
});

describe("buildStoppedPayload", () => {
  it("reads Stopped, names the last track, and has no buttons", () => {
    const p = buildStoppedPayload("Song A");
    expect(p.embeds[0]!.author?.name).toBe("Stopped");
    expect(p.embeds[0]!.title).toBe("Song A");
    expect(p.components).toEqual([]);
  });
});

/** A fake gateway recording sends/edits, with a configurable "latest message" id. */
function fakeGateway(opts: { latest?: string | null } = {}) {
  let counter = 0;
  let latest: string | null = opts.latest ?? null;
  const send = vi.fn(async (_channelId: string, _payload: NpPayload) => {
    const id = `m${++counter}`;
    latest = id;
    return id;
  });
  const edit = vi.fn(async (_c: string, _id: string, _p: NpPayload) => {});
  const latestMessageId = vi.fn(async (_c: string) => latest);
  const gateway: NpGateway = { send, edit, latestMessageId };
  return { gateway, send, edit, latestMessageId, setLatest: (v: string | null) => (latest = v) };
}

const flush = async (): Promise<void> => {
  // let debounce timers + chained flush promises settle
  await vi.runAllTimersAsync();
};

describe("NowPlayingManager — lifecycle", () => {
  it("posts on first track start, then EDITS on a track change", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    let s = snap();
    ctrl.snapshot = () => s;
    const mgr = new NowPlayingManager({ gateway, channelFor: () => "chan1", debounceMs: 10 });
    mgr.attach("g1", ctrl as never);

    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("chan1");
    expect(send.mock.calls[0]![1].embeds[0]!.title).toBe("Song A");

    s = snap({ current: { ...item("bbb", "Song B"), positionMs: 0, durationMs: 1000 } });
    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1); // no second post
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]![1]).toBe("m1");
    expect(edit.mock.calls[0]![2].embeds[0]!.title).toBe("Song B");
    vi.useRealTimers();
  });

  it("does NOT post when no command channel is known yet", async () => {
    vi.useFakeTimers();
    const { gateway, send } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    ctrl.snapshot = () => snap();
    const mgr = new NowPlayingManager({ gateway, channelFor: () => null, debounceMs: 10 });
    mgr.attach("g1", ctrl as never);
    ctrl.emit("changed");
    await flush();
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("finalizes to a Stopped card on idle (edits the existing message, no buttons)", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    let s = snap();
    ctrl.snapshot = () => s;
    const mgr = new NowPlayingManager({ gateway, channelFor: () => "chan1", debounceMs: 10 });
    mgr.attach("g1", ctrl as never);

    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    s = idleSnap();
    ctrl.emit("changed");
    await flush();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]![2].embeds[0]!.author?.name).toBe("Stopped");
    expect(edit.mock.calls[0]![2].embeds[0]!.title).toBe("Song A");
    expect(edit.mock.calls[0]![2].components).toEqual([]);
    vi.useRealTimers();
  });

  it("does not post a Stopped card when nothing was ever playing", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    ctrl.snapshot = () => idleSnap();
    const mgr = new NowPlayingManager({ gateway, channelFor: () => "chan1", debounceMs: 10 });
    mgr.attach("g1", ctrl as never);
    ctrl.emit("changed");
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("REPOSTS when the existing message was deleted (edit rejects)", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    let s = snap();
    ctrl.snapshot = () => s;
    const mgr = new NowPlayingManager({ gateway, channelFor: () => "chan1", debounceMs: 10 });
    mgr.attach("g1", ctrl as never);

    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    edit.mockRejectedValueOnce(new Error("Unknown Message"));
    s = snap({ current: { ...item("bbb", "Song B"), positionMs: 0, durationMs: 1000 } });
    ctrl.emit("changed");
    await flush();

    expect(edit).toHaveBeenCalledTimes(1); // attempted edit
    expect(send).toHaveBeenCalledTimes(2); // then reposted
    expect(send.mock.calls[1]![1].embeds[0]!.title).toBe("Song B");
    vi.useRealTimers();
  });

  it("REPOSTS when our message is no longer the latest in the channel", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit, setLatest } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    let s = snap();
    ctrl.snapshot = () => s;
    const mgr = new NowPlayingManager({ gateway, channelFor: () => "chan1", debounceMs: 10 });
    mgr.attach("g1", ctrl as never);

    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1); // posted m1, latest=m1

    setLatest("someoneElse"); // a different, newer message arrived
    s = snap({ current: { ...item("bbb", "Song B"), positionMs: 0, durationMs: 1000 } });
    ctrl.emit("changed");
    await flush();

    expect(edit).not.toHaveBeenCalled(); // buried → don't edit
    expect(send).toHaveBeenCalledTimes(2); // repost instead
    vi.useRealTimers();
  });

  it("never throws into playback: a sending failure is swallowed to onError", async () => {
    vi.useFakeTimers();
    const { gateway, send } = fakeGateway();
    send.mockRejectedValue(new Error("network"));
    const onError = vi.fn();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    ctrl.snapshot = () => snap();
    const mgr = new NowPlayingManager({
      gateway,
      channelFor: () => "chan1",
      debounceMs: 10,
      onError,
    });
    mgr.attach("g1", ctrl as never);
    ctrl.emit("changed");
    await flush();
    expect(onError).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("attach is idempotent (one subscription per guild)", async () => {
    vi.useFakeTimers();
    const { gateway, send } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    ctrl.snapshot = () => snap();
    const mgr = new NowPlayingManager({ gateway, channelFor: () => "chan1", debounceMs: 10 });
    mgr.attach("g1", ctrl as never);
    mgr.attach("g1", ctrl as never);
    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
