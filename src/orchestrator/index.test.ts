import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { GuildController } from "./index.js";
import { Semaphore } from "../util/semaphore.js";
import type { Requester, TrackMeta } from "../types/index.js";

const requester: Requester = {
  discordUserId: "1",
  displayName: "u",
  avatarUrl: "a",
  source: "discord",
};
const meta = (id: string): TrackMeta => ({
  videoId: id,
  title: id,
  channel: "c",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
});

class FakeSession extends EventEmitter {
  play = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  skip = vi.fn(() => this.emit("trackEnd")); // simulate stop -> trackEnd
  stop = vi.fn();
  startIdleTimer = vi.fn();
  cancelIdleTimer = vi.fn();
  setIdleTimeout = vi.fn();
  destroy = vi.fn();
  channelId = "C1";
}

function makeController(
  overrides: {
    downloadFn?: (id: string) => Promise<string>;
    onTrackError?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const session = new FakeSession();
  const cacheStore = new Map<string, string>();
  const deps = {
    youtube: {
      download: vi.fn(overrides.downloadFn ?? (async (id: string) => `/cache/${id}.webm`)),
    },
    cache: {
      get: (id: string) => cacheStore.get(id) ?? null,
      has: (id: string) => cacheStore.has(id),
      register: (id: string, p: string) => cacheStore.set(id, p),
      pin: vi.fn(),
      unpin: vi.fn(),
    },
    cacheDir: "/cache",
    createSession: vi.fn(async () => session as never),
    makeResource: (p: string) => ({ res: p }),
    prefetchDepth: 1,
    idleTimeoutMs: 300_000,
    downloads: new Semaphore(2),
    onTrackError: overrides.onTrackError,
  };
  const ctrl = new GuildController("G1", deps as never);
  return { ctrl, session, deps };
}

describe("GuildController", () => {
  it("enqueue connects, downloads, and plays the first track", async () => {
    const { ctrl, session, deps } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    // allow the changed/prefetch microtasks + playNext to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.youtube.download).toHaveBeenCalledWith("aaaaaaaaaaa", "/cache");
    expect(session.play).toHaveBeenCalledTimes(1);
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
  });

  it("advances to the next track on trackEnd, and idles when empty", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    session.emit("trackEnd"); // first ends
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");

    session.emit("trackEnd"); // second ends -> empty
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current).toBeNull();
    expect(session.startIdleTimer).toHaveBeenCalled();
  });

  it("skip stops the player (which advances)", async () => {
    const { ctrl } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.skip(); // FakeSession.skip emits trackEnd
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
  });

  it("idle event leaves the channel", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    session.emit("idle");
    await new Promise((r) => setTimeout(r, 0));
    expect(session.destroy).toHaveBeenCalled();
  });

  it("C1: skips a track whose download fails and plays the next one", async () => {
    const badId = "bbbbbbbbbbb";
    const goodId = "ggggggggggg";
    const onTrackError = vi.fn();
    const { ctrl, session } = makeController({
      downloadFn: async (id: string) => {
        if (id === badId) throw new Error("gone");
        return `/cache/${id}.webm`;
      },
      onTrackError,
    });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta(badId), requester);
    await ctrl.enqueue(meta(goodId), requester);
    // allow async playback loop to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(ctrl.snapshot().current?.meta.videoId).toBe(goodId);
    expect(session.play).toHaveBeenCalledTimes(1);
    expect(onTrackError).toHaveBeenCalledWith({
      videoId: badId,
      title: badId,
      reason: "download_failed",
    });
  });

  it("I1: concurrent ensureConnected calls create only one session", async () => {
    const { ctrl, deps } = makeController();
    await Promise.all([ctrl.ensureConnected("C1"), ctrl.ensureConnected("C1")]);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });

  it("session error event advances to the next track", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    session.emit("error", new Error("x"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
  });
});

describe("GuildController playback position + paused", () => {
  function makeClockController() {
    let t = 1000;
    const now = () => t;
    const session = new FakeSession();
    const cacheStore = new Map<string, string>();
    const deps = {
      youtube: { download: vi.fn(async (id: string) => `/cache/${id}.webm`) },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string) => cacheStore.set(id, p),
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => session as never),
      makeResource: (p: string) => ({ res: p }),
      prefetchDepth: 1,
      idleTimeoutMs: 300_000,
      downloads: new Semaphore(2),
      now,
    };
    const ctrl = new GuildController("G1", deps as never);
    return { ctrl, session, deps, advanceClock: (ms: number) => (t += ms) };
  }

  it("reports positionMs/durationMs on the current track, accounting for pauses", async () => {
    const { ctrl, advanceClock } = makeClockController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    // Just started -> ~0ms elapsed.
    let snap = ctrl.snapshot();
    expect(snap.current?.positionMs).toBe(0);
    // durationSec is 100 -> durationMs 100000.
    expect(snap.current?.durationMs).toBe(100000);
    expect(snap.paused).toBe(false);

    advanceClock(5000);
    snap = ctrl.snapshot();
    expect(snap.current?.positionMs).toBe(5000);

    // Pause -> position freezes and paused flips true.
    ctrl.pause();
    advanceClock(3000);
    snap = ctrl.snapshot();
    expect(snap.paused).toBe(true);
    expect(snap.current?.positionMs).toBe(5000); // frozen while paused

    // Resume -> clock counts again but the paused gap is excluded.
    ctrl.resume();
    advanceClock(2000);
    snap = ctrl.snapshot();
    expect(snap.paused).toBe(false);
    expect(snap.current?.positionMs).toBe(7000);
  });

  it("resets position on track advance", async () => {
    const { ctrl, session, advanceClock } = makeClockController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    advanceClock(9000);
    expect(ctrl.snapshot().current?.positionMs).toBe(9000);
    session.emit("trackEnd");
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
    expect(ctrl.snapshot().current?.positionMs).toBe(0);
  });

  it("the LAST 'changed' broadcast on a skip carries the NEW track with its position reset to 0", async () => {
    // Regression: the broadcaster turns every controller "changed" into a now-playing
    // snapshot. On a skip/advance the controller emitted "changed" from inside
    // queue.advance() — BEFORE markTrackStarted() resets the position — so the panel
    // received the new track stamped with the PREVIOUS track's elapsed position and no
    // corrected broadcast ever followed (stale now-playing card). The snapshot at the
    // FINAL "changed" emit (what the panel renders) must reflect the freshly-started track.
    const { ctrl, session, advanceClock } = makeClockController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    advanceClock(45000); // track A has been playing 45s

    // Capture the snapshot exactly as the broadcaster would at each "changed".
    const emitted: { videoId: string | null; positionMs: number | undefined }[] = [];
    ctrl.on("changed", () => {
      const cur = ctrl.snapshot().current;
      emitted.push({ videoId: cur?.meta.videoId ?? null, positionMs: cur?.positionMs });
    });

    session.emit("trackEnd"); // skip/advance to B
    await new Promise((r) => setTimeout(r, 0));

    const last = emitted.at(-1);
    expect(last?.videoId).toBe("bbbbbbbbbbb"); // new track
    expect(last?.positionMs).toBe(0); // position reset for the new track (was the stale 45000)
  });

  it("emits 'changed' on pause, resume, skip and stop so the panel stays live", async () => {
    const { ctrl, session } = makeClockController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    const changed = vi.fn();
    ctrl.on("changed", changed);
    ctrl.pause();
    expect(changed).toHaveBeenCalledTimes(1);
    ctrl.resume();
    expect(changed).toHaveBeenCalledTimes(2);
    ctrl.skip(); // FakeSession.skip emits trackEnd which advances (queue change)
    await new Promise((r) => setTimeout(r, 0));
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(3);
    const before = changed.mock.calls.length;
    void session;
    await ctrl.stop();
    expect(changed.mock.calls.length).toBeGreaterThan(before);
  });

  it("stop clears the queue and stays in the channel (no immediate leave; idle timeout disconnects later)", async () => {
    const { ctrl, session } = makeClockController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    await ctrl.stop();
    expect(session.stop).toHaveBeenCalled();
    expect(session.destroy).not.toHaveBeenCalled();
    expect(session.startIdleTimer).toHaveBeenCalled();
  });
});

describe("GuildController.moveTo", () => {
  it("destroys old session, creates new for new channel, plays current without advancing", async () => {
    // Set up two separate FakeSessions so we can tell them apart.
    const sessionC1 = new FakeSession();
    sessionC1.channelId = "C1";
    const sessionC2 = new FakeSession();
    sessionC2.channelId = "C2";
    const sessions = [sessionC1, sessionC2];
    let sessionIdx = 0;

    const cacheStore = new Map<string, string>();
    const deps = {
      youtube: { download: vi.fn(async (id: string) => `/cache/${id}.webm`) },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string) => cacheStore.set(id, p),
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => sessions[sessionIdx++] as never),
      makeResource: (p: string) => ({ res: p }),
      prefetchDepth: 1,
      downloads: new Semaphore(2),
    };
    const ctrl = new GuildController("G1", deps as never);

    // Connect to C1 and enqueue a track so there is a current item.
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0)); // allow playNextLocked to run
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(sessionC1.play).toHaveBeenCalledTimes(1);

    // Move to C2 — should NOT advance the queue (still "aaaaaaaaaaa" as current).
    await ctrl.moveTo("C2");

    // Old session destroyed.
    expect(sessionC1.destroy).toHaveBeenCalled();
    // New session created for C2.
    expect(deps.createSession).toHaveBeenCalledTimes(2);
    expect(deps.createSession.mock.calls.at(-1)?.[0]).toBe("C2");
    // Current track replayed on new session (playItemLocked, not advance).
    expect(sessionC2.play).toHaveBeenCalledTimes(1);
    // Queue current is still the same track (no double-advance).
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
  });

  it("moveTo with no current: connects new session and starts queued track via advance", async () => {
    // Two sessions: first for C2 (no C1 connect — we call moveTo without ensureConnected first).
    const sessionC2 = new FakeSession();
    sessionC2.channelId = "C2";

    const cacheStore = new Map<string, string>();
    const deps = {
      youtube: { download: vi.fn(async (id: string) => `/cache/${id}.webm`) },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string) => cacheStore.set(id, p),
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => sessionC2 as never),
      makeResource: (p: string) => ({ res: p }),
      prefetchDepth: 1,
      downloads: new Semaphore(2),
    };
    const ctrl = new GuildController("G1", deps as never);

    // Enqueue ONE track WITHOUT connecting first — current is null, nothing plays.
    await ctrl.queue.add(meta("aaaaaaaaaaa"), requester);
    expect(ctrl.snapshot().current).toBeNull();
    expect(ctrl.snapshot().upcoming).toHaveLength(1);

    // moveTo should connect C2 and advance+play the queued track.
    await ctrl.moveTo("C2");
    await new Promise((r) => setTimeout(r, 0)); // settle any microtasks

    // New session created for C2.
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect(deps.createSession.mock.calls[0]?.[0]).toBe("C2");
    // Queue advanced: the upcoming track is now current.
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    // play was called exactly once (via playNextLocked -> playItemLocked).
    expect(sessionC2.play).toHaveBeenCalledTimes(1);
  });
});

describe("GuildController idle timeout (per-guild, runtime-adjustable)", () => {
  it("defaults the idle timeout from deps.idleTimeoutMs (300s) and exposes it in the snapshot", async () => {
    const { ctrl } = makeController();
    expect(ctrl.getIdleTimeoutSec()).toBe(300);
    expect(ctrl.snapshot().idleTimeoutSec).toBe(300);
  });

  it("setIdleTimeoutSec updates the field, the snapshot, emits 'changed', and applies to the live session", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    const changed = vi.fn();
    ctrl.on("changed", changed);

    ctrl.setIdleTimeoutSec(60);

    expect(ctrl.getIdleTimeoutSec()).toBe(60);
    expect(ctrl.snapshot().idleTimeoutSec).toBe(60);
    expect(changed).toHaveBeenCalledTimes(1);
    // Applied to the currently-connected session in ms.
    expect(session.setIdleTimeout).toHaveBeenCalledWith(60_000);
  });

  it("setIdleTimeoutSec with no live session still updates the field + snapshot + emits 'changed'", () => {
    const { ctrl } = makeController();
    const changed = vi.fn();
    ctrl.on("changed", changed);
    ctrl.setIdleTimeoutSec(15);
    expect(ctrl.getIdleTimeoutSec()).toBe(15);
    expect(ctrl.snapshot().idleTimeoutSec).toBe(15);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("a NEWLY-created session is constructed with the updated idle timeout", async () => {
    // createSession is the per-channel factory; the controller passes its current
    // idleTimeoutMs to it so freshly-created sessions honor the runtime value.
    const sessions: FakeSession[] = [];
    const cacheStore = new Map<string, string>();
    const deps = {
      youtube: { download: vi.fn(async (id: string) => `/cache/${id}.webm`) },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string) => cacheStore.set(id, p),
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async (_channelId: string, idleTimeoutMs?: number) => {
        const s = new FakeSession();
        (s as unknown as { idleTimeoutMs?: number }).idleTimeoutMs = idleTimeoutMs;
        sessions.push(s);
        return s as never;
      }),
      makeResource: (p: string) => ({ res: p }),
      prefetchDepth: 1,
      idleTimeoutMs: 300_000,
      downloads: new Semaphore(2),
    };
    const ctrl = new GuildController("G1", deps as never);
    ctrl.setIdleTimeoutSec(120);
    await ctrl.ensureConnected("C1");
    // The factory was invoked with the updated timeout (120s = 120000ms).
    const lastCall = deps.createSession.mock.calls.at(-1)!;
    expect(lastCall[1]).toBe(120_000);
  });
});
