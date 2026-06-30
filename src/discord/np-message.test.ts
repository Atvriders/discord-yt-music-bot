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
    commandChannelId: null,
    preparing: null,
    ...overrides,
  };
}

const idleSnap = (): ControllerSnapshot => snap({ current: null });

describe("np customId codec", () => {
  it("round-trips every action", () => {
    for (const a of [
      "pauseresume",
      "skip",
      "stop",
      "shuffle",
      "repeat",
      "autodiscover",
      "voldown",
      "volup",
    ] as const) {
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

/** Collect all field name->value pairs from the first embed of a payload. */
function fieldVal(p: NpPayload, name: string): string | undefined {
  return (p.embeds[0]!.fields ?? []).find((f) => f.name === name)?.value;
}
/** All button customIds across every action row, in order. */
function allButtonIds(p: NpPayload): string[] {
  return p.components.flatMap((row) =>
    row.components.map((c) => (c as { custom_id: string }).custom_id),
  );
}
/** Find a serialized button by its customId across all rows. */
function buttonById(p: NpPayload, customId: string) {
  for (const row of p.components) {
    for (const c of row.components) {
      if ((c as { custom_id?: string }).custom_id === customId) {
        return c as { custom_id: string; label?: string; style?: number };
      }
    }
  }
  return undefined;
}

describe("buildNowPlayingPayload", () => {
  it("renders title, thumbnail, requester, duration and the first control-button row", () => {
    const p = buildNowPlayingPayload(snap({ upcoming: [item("bbb"), item("ccc")] }));
    const embed = p.embeds[0]!;
    expect(embed.title).toBe("Song A");
    expect(embed.thumbnail?.url).toBe("http://t/aaa");
    expect(fieldVal(p, "Requested by")).toBe("Alice");

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
    expect(p.embeds[0]!.author?.name).toContain("Paused");
    const first = p.components[0]!.components[0] as { label?: string };
    expect(first.label).toBe("Resume");
  });

  it("includes the requester display name", () => {
    const cur = item("aaa", "Song A");
    cur.requester = { discordUserId: "9", displayName: "Bob", avatarUrl: "b", source: "discord" };
    const p = buildNowPlayingPayload(
      snap({ current: { ...cur, positionMs: 0, durationMs: 213000 } }),
    );
    expect(fieldVal(p, "Requested by")).toBe("Bob");
  });

  it("renders the audio format (codec · bitrate · sample-rate) when present", () => {
    const cur = item("aaa", "Song A");
    cur.audio = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
    const p = buildNowPlayingPayload(
      snap({ current: { ...cur, positionMs: 0, durationMs: 213000 } }),
    );
    const fmt = fieldVal(p, "Format");
    expect(fmt).toContain("opus");
    expect(fmt).toContain("160");
    expect(fmt).toContain("48"); // 48 kHz
  });

  it("omits the format field when no audio info is present", () => {
    const p = buildNowPlayingPayload(snap());
    expect(fieldVal(p, "Format")).toBeUndefined();
  });

  it("renders a progress line: elapsed / duration and a text bar reflecting positionMs", () => {
    const cur = item("aaa", "Song A", 200);
    // 100s into a 200s track → halfway.
    const p = buildNowPlayingPayload(
      snap({ current: { ...cur, positionMs: 100_000, durationMs: 200_000 } }),
    );
    const prog = fieldVal(p, "Progress")!;
    expect(prog).toContain("1:40"); // elapsed
    expect(prog).toContain("3:20"); // duration
    // A simple text bar with a position marker.
    expect(prog).toMatch(/[▬◍]/);
  });

  it("shows the queue length (count of upcoming tracks)", () => {
    const p = buildNowPlayingPayload(snap({ upcoming: [item("bbb"), item("ccc"), item("ddd")] }));
    expect(fieldVal(p, "Queue")).toBe("3");
  });

  it('shows "Up next: <title>" for the first upcoming track', () => {
    const p = buildNowPlayingPayload(snap({ upcoming: [item("bbb", "Next Song"), item("ccc")] }));
    expect(fieldVal(p, "Up next")).toBe("Next Song");
  });

  it('shows "Up next: —" when nothing is queued', () => {
    const p = buildNowPlayingPayload(snap({ upcoming: [] }));
    expect(fieldVal(p, "Up next")).toBe("—");
  });

  it("reflects a clear playing/paused state marker in the author line", () => {
    expect(buildNowPlayingPayload(snap({ paused: false })).embeds[0]!.author?.name).toContain(
      "Now Playing",
    );
    expect(buildNowPlayingPayload(snap({ paused: true })).embeds[0]!.author?.name).toContain(
      "Paused",
    );
  });

  it("renders volume, repeat and auto-discover state as small fields", () => {
    const p = buildNowPlayingPayload(snap({ volume: 80, repeat: "all", autoplay: true }));
    expect(fieldVal(p, "Volume")).toContain("80");
    expect(fieldVal(p, "Repeat")).toContain("all");
    const auto = fieldVal(p, "Auto-discover")!;
    expect(auto.toLowerCase()).toContain("on");
  });

  it("formats hour-long durations in the progress line", () => {
    const cur = item("aaa", "Long", 3725);
    const p = buildNowPlayingPayload(
      snap({ current: { ...cur, positionMs: 0, durationMs: 3725000 } }),
    );
    expect(fieldVal(p, "Progress")).toContain("1:02:05");
  });

  it("adds a second action row with repeat / auto-discover / vol- / vol+ buttons", () => {
    const p = buildNowPlayingPayload(snap());
    expect(p.components.length).toBe(2);
    const secondIds = p.components[1]!.components.map(
      (c) => (c as { custom_id: string }).custom_id,
    );
    expect(secondIds).toEqual([
      encodeNpAction("repeat"),
      encodeNpAction("autodiscover"),
      encodeNpAction("voldown"),
      encodeNpAction("volup"),
    ]);
    // No row exceeds Discord's 5-button limit.
    for (const row of p.components) expect(row.components.length).toBeLessThanOrEqual(5);
  });

  it("the repeat button label reflects the current repeat mode", () => {
    expect(
      buttonById(buildNowPlayingPayload(snap({ repeat: "off" })), encodeNpAction("repeat"))?.label,
    ).toMatch(/off/i);
    expect(
      buttonById(buildNowPlayingPayload(snap({ repeat: "one" })), encodeNpAction("repeat"))?.label,
    ).toMatch(/one|1|track/i);
    expect(
      buttonById(buildNowPlayingPayload(snap({ repeat: "all" })), encodeNpAction("repeat"))?.label,
    ).toMatch(/all/i);
  });

  it("the auto-discover button shows on/off matching autoplay state", () => {
    const on = buttonById(
      buildNowPlayingPayload(snap({ autoplay: true })),
      encodeNpAction("autodiscover"),
    );
    const off = buttonById(
      buildNowPlayingPayload(snap({ autoplay: false })),
      encodeNpAction("autodiscover"),
    );
    expect(on?.label?.toLowerCase()).toContain("on");
    expect(off?.label?.toLowerCase()).toContain("off");
    // The on/off state is also reflected via a distinct button style.
    expect(on?.style).not.toBe(off?.style);
  });

  it("never produces a button row with more than 5 buttons and keeps all np customIds", () => {
    const p = buildNowPlayingPayload(snap());
    const ids = allButtonIds(p);
    for (const a of [
      "pauseresume",
      "skip",
      "stop",
      "shuffle",
      "repeat",
      "autodiscover",
      "voldown",
      "volup",
    ] as const) {
      expect(ids).toContain(encodeNpAction(a));
    }
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

  it("posts in the configured command channel when one is set (preferred over channelFor)", async () => {
    vi.useFakeTimers();
    const { gateway, send } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    ctrl.snapshot = () => snap();
    const mgr = new NowPlayingManager({
      gateway,
      // commandChannelFor wins over the last-command channelFor when it returns an id.
      channelFor: () => "last-cmd-chan",
      commandChannelFor: () => "restricted-chan",
      debounceMs: 10,
    });
    mgr.attach("g1", ctrl as never);
    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("restricted-chan");
    vi.useRealTimers();
  });

  it("falls back to channelFor when no command channel is configured (commandChannelFor null)", async () => {
    vi.useFakeTimers();
    const { gateway, send } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    ctrl.snapshot = () => snap();
    const mgr = new NowPlayingManager({
      gateway,
      channelFor: () => "last-cmd-chan",
      commandChannelFor: () => null,
      debounceMs: 10,
    });
    mgr.attach("g1", ctrl as never);
    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("last-cmd-chan");
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

  it("THROTTLES rapid state changes: a burst coalesces into a single post + edit", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    let s = snap();
    ctrl.snapshot = () => s;
    // A real-world ~1.5–2s min interval; use a larger throttle so the burst is clearly coalesced.
    const mgr = new NowPlayingManager({
      gateway,
      channelFor: () => "chan1",
      debounceMs: 10,
      minEditIntervalMs: 1500,
    });
    mgr.attach("g1", ctrl as never);

    // First change posts.
    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    // Now hammer with many rapid control-driven changes inside the throttle window.
    for (let i = 0; i < 10; i++) {
      s = snap({ volume: 100 - i });
      ctrl.emit("changed");
    }
    await flush();
    // All those coalesce into EXACTLY one edit (the latest state), not ten and not zero.
    // A strict count + an unconditional assertion fail loudly if a future change drops the
    // burst to zero edits (the conditional previously hid that regression).
    expect(edit).toHaveBeenCalledTimes(1);
    // The single edit reflects the LAST state in the burst (volume 91).
    expect(
      edit.mock.calls[0]![2].embeds[0]!.fields?.find((f) => f.name === "Volume")?.value,
    ).toContain("91");
    vi.useRealTimers();
  });

  it("THROTTLES an event that arrives while an edit's I/O is in flight to the FULL min interval, not debounce", async () => {
    vi.useFakeTimers();
    // Record the wall-clock time of each gateway.edit. The edit I/O itself takes EDIT_MS, and
    // a `changed` event lands inside that in-flight window. We assert the SECOND edit is spaced
    // at least minEditIntervalMs after the FIRST edit's start — i.e. the schedule throttled
    // against the in-flight edit. Before the fix, scheduleUpdate measured against the stale
    // pre-flush lastEditAt, collapsing `wait` to debounceMs and spacing the edits ~EDIT_MS apart.
    const EDIT_MS = 300;
    const minEditIntervalMs = 1500;
    const editTimes: number[] = [];
    let counter = 0;
    let latest: string | null = null;
    const send = vi.fn(async (_c: string, _p: NpPayload) => {
      const id = `m${++counter}`;
      latest = id;
      return id;
    });
    const edit = vi.fn(async (_c: string, _id: string, _p: NpPayload) => {
      editTimes.push(Date.now());
      await new Promise<void>((r) => setTimeout(r, EDIT_MS));
    });
    const latestMessageId = vi.fn(async (_c: string) => latest);
    const gateway: NpGateway = { send, edit, latestMessageId };

    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    let s = snap();
    ctrl.snapshot = () => s;
    const mgr = new NowPlayingManager({
      gateway,
      channelFor: () => "chan1",
      debounceMs: 10,
      minEditIntervalMs,
    });
    mgr.attach("g1", ctrl as never);

    // 1) First change posts (send), stamps lastEditAt.
    ctrl.emit("changed");
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);

    // 2) Move past the min interval, then change → this triggers the first EDIT.
    await vi.advanceTimersByTimeAsync(minEditIntervalMs + 50);
    s = snap({ current: { ...item("bbb", "Song B"), positionMs: 0, durationMs: 1000 } });
    ctrl.emit("changed");
    // Advance just enough for the debounce to fire and the edit to start (but not complete).
    await vi.advanceTimersByTimeAsync(20);
    expect(edit).toHaveBeenCalledTimes(1);
    const firstEditAt = editTimes[0]!;

    // 3) A new change lands WHILE edit #1 is still in flight (EDIT_MS not yet elapsed).
    s = snap({ current: { ...item("ccc", "Song C"), positionMs: 0, durationMs: 1000 } });
    ctrl.emit("changed");

    // 4) Drain everything.
    await vi.runAllTimersAsync();

    // Exactly one more edit, reflecting the latest state, spaced ≥ minEditIntervalMs after the
    // first edit — proving the in-flight edit was treated as "just happened" by the throttle.
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1]![2].embeds[0]!.title).toBe("Song C");
    expect(editTimes[1]! - firstEditAt).toBeGreaterThanOrEqual(minEditIntervalMs);
    vi.useRealTimers();
  });

  it("does NOT edit on its own (no per-second refresh timer): silence ⇒ no edits", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit } = fakeGateway();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    ctrl.snapshot = () =>
      snap({ current: { ...item("aaa", "Song A"), positionMs: 1000, durationMs: 200000 } });
    const mgr = new NowPlayingManager({
      gateway,
      channelFor: () => "chan1",
      debounceMs: 10,
      minEditIntervalMs: 1500,
    });
    mgr.attach("g1", ctrl as never);

    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    // Advance a long time with NO further "changed" events. A per-second refresh timer would
    // fire repeated edits here; we must see none.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(edit).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("a failing edit does not throw into playback (swallowed to onError)", async () => {
    vi.useFakeTimers();
    const { gateway, send, edit } = fakeGateway();
    const onError = vi.fn();
    const ctrl = new EventEmitter() as EventEmitter & { snapshot: () => ControllerSnapshot };
    let s = snap();
    ctrl.snapshot = () => s;
    const mgr = new NowPlayingManager({
      gateway,
      channelFor: () => "chan1",
      debounceMs: 10,
      onError,
    });
    mgr.attach("g1", ctrl as never);

    ctrl.emit("changed");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    // The edit AND the repost both fail: the manager must swallow it, not throw.
    edit.mockRejectedValue(new Error("Unknown Message"));
    send.mockRejectedValueOnce(new Error("network"));
    s = snap({ current: { ...item("bbb", "Song B"), positionMs: 0, durationMs: 1000 } });
    ctrl.emit("changed");
    // Must resolve without an unhandled rejection.
    await expect(flush()).resolves.toBeUndefined();
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
