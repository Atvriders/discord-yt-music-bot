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
  destroy = vi.fn();
  channelId = "C1";
}

function makeController(overrides: { downloadFn?: (id: string) => Promise<string> } = {}) {
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
    downloads: new Semaphore(2),
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
    const { ctrl, session } = makeController({
      downloadFn: async (id: string) => {
        if (id === badId) throw new Error("gone");
        return `/cache/${id}.webm`;
      },
    });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta(badId), requester);
    await ctrl.enqueue(meta(goodId), requester);
    // allow async playback loop to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(ctrl.snapshot().current?.meta.videoId).toBe(goodId);
    expect(session.play).toHaveBeenCalledTimes(1);
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
    expect(deps.createSession).toHaveBeenLastCalledWith("C2");
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
    expect(deps.createSession).toHaveBeenCalledWith("C2");
    // Queue advanced: the upcoming track is now current.
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    // play was called exactly once (via playNextLocked -> playItemLocked).
    expect(sessionC2.play).toHaveBeenCalledTimes(1);
  });
});
