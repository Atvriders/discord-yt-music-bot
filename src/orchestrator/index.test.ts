import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { GuildController, AUTOPLAY_MAX_CHAIN } from "./index.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { Semaphore } from "../util/semaphore.js";
import type { AudioInfo, Requester, TrackMeta } from "../types/index.js";

const AUDIO: AudioInfo = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };

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
    downloadFn?: (id: string) => Promise<{ path: string; audio: AudioInfo | null }>;
    relatedFn?: (id: string) => Promise<TrackMeta[]>;
    artistTracksFn?: (meta: TrackMeta) => Promise<TrackMeta[]>;
    onTrackError?: ReturnType<typeof vi.fn>;
    onTrackStart?: ReturnType<typeof vi.fn>;
    onIdle?: ReturnType<typeof vi.fn>;
    now?: () => number;
    settings?: Partial<import("./settings.js").GuildSettings>;
  } = {},
) {
  const session = new FakeSession();
  const cacheStore = new Map<string, string>();
  const audioStore = new Map<string, AudioInfo | null>();
  const makeResource = vi.fn((p: string, _item: unknown, opts?: { seekMs?: number }) => ({
    res: p,
    seekMs: opts?.seekMs ?? 0,
  }));
  const related = vi.fn(overrides.relatedFn ?? (async () => [] as TrackMeta[]));
  const artistTracks = vi.fn(overrides.artistTracksFn ?? (async () => [] as TrackMeta[]));
  const deps = {
    youtube: {
      download: vi.fn(
        overrides.downloadFn ??
          (async (id: string) => ({ path: `/cache/${id}.webm`, audio: AUDIO })),
      ),
      related,
      artistTracks,
    },
    cache: {
      get: (id: string) => cacheStore.get(id) ?? null,
      getAudio: (id: string) => audioStore.get(id) ?? null,
      has: (id: string) => cacheStore.has(id),
      register: (id: string, p: string, audio: AudioInfo | null = null) => {
        cacheStore.set(id, p);
        audioStore.set(id, audio);
      },
      pin: vi.fn(),
      unpin: vi.fn(),
    },
    cacheDir: "/cache",
    createSession: vi.fn(async () => session as never),
    makeResource,
    prefetchDepth: 1,
    idleTimeoutMs: 300_000,
    downloads: new Semaphore(2),
    now: overrides.now,
    onTrackError: overrides.onTrackError,
    onTrackStart: overrides.onTrackStart,
    onIdle: overrides.onIdle,
    settings: { ...DEFAULT_SETTINGS, ...overrides.settings },
  };
  const ctrl = new GuildController("G1", deps as never);
  return { ctrl, session, deps, makeResource, related, artistTracks };
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

  it("fires onTrackStart with the started track's meta (drives presence)", async () => {
    const onTrackStart = vi.fn();
    const { ctrl } = makeController({ onTrackStart });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(onTrackStart).toHaveBeenCalledTimes(1);
    expect(onTrackStart.mock.calls[0]![0]).toMatchObject({
      videoId: "aaaaaaaaaaa",
      title: "aaaaaaaaaaa",
    });
  });

  it("fires onIdle when the voice session goes idle and is torn down (reverts presence)", async () => {
    const onIdle = vi.fn();
    const { ctrl, session } = makeController({ onIdle });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    // The idle-disconnect timer firing emits "idle" -> leaveInternal tears down the session.
    session.emit("idle");
    await new Promise((r) => setTimeout(r, 0));
    expect(onIdle).toHaveBeenCalled();
  });

  it("attaches the downloaded audio format to snapshot.current", async () => {
    const { ctrl } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.audio).toEqual(AUDIO);
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

  it("shuffle permutes the upcoming list without touching the current track", async () => {
    const { ctrl } = makeController();
    await ctrl.ensureConnected("C1");
    for (const v of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee"]) {
      await ctrl.enqueue(meta(v), requester);
    }
    await new Promise((r) => setTimeout(r, 0));
    // a* is now current; b..e are upcoming.
    const before = ctrl.snapshot().upcoming.map((i) => i.meta.videoId);
    await ctrl.shuffle(() => 0); // deterministic cascade — a known non-identity permutation
    const after = ctrl.snapshot().upcoming.map((i) => i.meta.videoId);
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect([...after].sort()).toEqual([...before].sort());
    expect(after).not.toEqual(before);
  });

  it("jumpTo plays the chosen item and DROPS the upcoming items before it", async () => {
    const { ctrl } = makeController();
    await ctrl.ensureConnected("C1");
    for (const v of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]) {
      await ctrl.enqueue(meta(v), requester);
    }
    await new Promise((r) => setTimeout(r, 0));
    // current = a; upcoming = [b, c, d]
    const target = ctrl.snapshot().upcoming.find((i) => i.meta.videoId === "ccccccccccc")!;
    const ok = await ctrl.jumpTo(target.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(ok).toBe(true);
    // c is now playing; the preceding b was dropped (not archived as a "played" track),
    // and only d remains upcoming.
    expect(ctrl.snapshot().current?.meta.videoId).toBe("ccccccccccc");
    expect(ctrl.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["ddddddddddd"]);
  });

  it("jumpTo returns false for an unknown item id (no state change)", async () => {
    const { ctrl } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    const ok = await ctrl.jumpTo("does-not-exist");
    expect(ok).toBe(false);
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(ctrl.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]);
  });

  it("idle event leaves the channel", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    session.emit("idle");
    await new Promise((r) => setTimeout(r, 0));
    expect(session.destroy).toHaveBeenCalled();
  });

  describe("per-guild max track length", () => {
    const longMeta = (id: string, durationSec: number): TrackMeta => ({
      ...meta(id),
      durationSec,
    });

    it("rejects an over-long enqueue with a TooLong reason when a per-guild limit is set", async () => {
      // 1h limit (3600s); a 3h (10800s) track must be rejected.
      const { ctrl, session } = makeController({ settings: { maxTrackDurationSec: 3600 } });
      await ctrl.ensureConnected("C1");
      session.play.mockClear();
      await expect(ctrl.enqueue(longMeta("aaaaaaaaaaa", 10800), requester)).rejects.toMatchObject({
        kind: "too_long",
      });
      // Nothing was queued or played.
      expect(session.play).not.toHaveBeenCalled();
      expect(ctrl.snapshot().current).toBeNull();
      expect(ctrl.snapshot().upcoming).toHaveLength(0);
    });

    it("includes the limit (in hours) in the rejection message", async () => {
      const { ctrl } = makeController({ settings: { maxTrackDurationSec: 7200 } }); // 2h
      await ctrl.ensureConnected("C1");
      await expect(ctrl.enqueue(longMeta("aaaaaaaaaaa", 10800), requester)).rejects.toThrow(/2h/);
    });

    it("allows a long track when it is UNDER the per-guild limit (3h video, 4h limit)", async () => {
      const { ctrl, session } = makeController({ settings: { maxTrackDurationSec: 14400 } }); // 4h
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(longMeta("aaaaaaaaaaa", 10800), requester); // 3h
      await new Promise((r) => setTimeout(r, 0));
      expect(session.play).toHaveBeenCalledTimes(1);
      expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    });

    it("allows ANY length when the limit is 0 (no limit)", async () => {
      const { ctrl, session } = makeController({ settings: { maxTrackDurationSec: 0 } });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(longMeta("aaaaaaaaaaa", 36000), requester); // 10h
      await new Promise((r) => setTimeout(r, 0));
      expect(session.play).toHaveBeenCalledTimes(1);
      expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    });

    it("allows a track with unknown duration (durationSec null) regardless of the limit", async () => {
      const { ctrl, session } = makeController({ settings: { maxTrackDurationSec: 60 } });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue({ ...meta("aaaaaaaaaaa"), durationSec: null }, requester);
      await new Promise((r) => setTimeout(r, 0));
      expect(session.play).toHaveBeenCalledTimes(1);
    });

    it("does NOT reject autoplay tracks on the per-guild limit (best-effort feed only)", async () => {
      // Autoplay (synthetic requester) should keep playing even if a related track is long;
      // the cap is a user-facing enqueue guard, not an autoplay killer.
      const { ctrl, session } = makeController({
        settings: { maxTrackDurationSec: 3600, autoplay: true },
        relatedFn: async () => [longMeta("bbbbbbbbbbb", 10800)],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester); // short seed (100s)
      await new Promise((r) => setTimeout(r, 0));
      session.emit("trackEnd"); // queue empties -> autoplay pulls the long related track
      await new Promise((r) => setTimeout(r, 0));
      expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
    });
  });

  it("C1: skips a track whose download fails and plays the next one", async () => {
    const badId = "bbbbbbbbbbb";
    const goodId = "ggggggggggg";
    const onTrackError = vi.fn();
    const { ctrl, session } = makeController({
      downloadFn: async (id: string) => {
        if (id === badId) throw new Error("gone");
        return { path: `/cache/${id}.webm`, audio: AUDIO };
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

  it("advances exactly once when a stream error fires both error and trackEnd", async () => {
    // Real @discordjs/voice typically emits BOTH an `error` event AND a Playing->Idle
    // stateChange (surfacing as `trackEnd`) for a single stream error. We advance on EITHER
    // signal (so an error-only end still progresses), but the per-track guard makes a same
    // -track error+trackEnd pair advance exactly once — never a double-skip.
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await ctrl.enqueue(meta("ccccccccccc"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    // Mirror the real ordering: error first, then the trackEnd from the Idle transition.
    session.emit("error", new Error("stream blew up"));
    session.emit("trackEnd");
    await new Promise((r) => setTimeout(r, 0));

    // Exactly ONE advance: we land on B, not C (which a double-advance would skip to).
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
    expect(ctrl.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["ccccccccccc"]);
  });

  it("advances on a terminal error alone (no trackEnd) — track is NOT left stuck", async () => {
    // The bug report: a track ended emitting ONLY a player `error` (a stream/ffmpeg/EOF
    // failure that never produced a clean Playing->Idle transition), so no `trackEnd` fired.
    // The finishing track must still advance to the next queued song without a manual Skip.
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    session.emit("error", new Error("ffmpeg died at EOF")); // ONLY error, never trackEnd
    await new Promise((r) => setTimeout(r, 0));

    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
  });

  it("advances exactly once when trackEnd and error fire together for the same track", async () => {
    // The same finishing-track pair in the opposite emit order (trackEnd then a same-tick
    // error, both queued behind the advance lock): the per-track guard is claimed
    // synchronously by the first signal, so the second is a no-op — exactly one advance.
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await ctrl.enqueue(meta("ccccccccccc"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    // Both signals for the same finished track, emitted before the async advance runs.
    session.emit("trackEnd");
    session.emit("error", new Error("same-track straggling error"));
    await new Promise((r) => setTimeout(r, 0));

    // Exactly ONE advance: land on B, not C.
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
    expect(ctrl.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["ccccccccccc"]);
  });

  it("error mid-track skips to the next track (each track's error advances once)", async () => {
    // A genuine per-track error in the middle of playback still advances — and because each
    // newly-started track opens a fresh advance generation, B's error advances to C.
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await ctrl.enqueue(meta("ccccccccccc"), requester);
    await new Promise((r) => setTimeout(r, 0));

    session.emit("error", new Error("a blew up mid-track"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");

    session.emit("error", new Error("b blew up mid-track too"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("ccccccccccc");
  });

  it("a session error SURFACES onTrackError (Couldn't play feedback) and skips to the next", async () => {
    // The regression: a track whose audio resource errors at play start was silently
    // advanced as if it had finished — no "✕ Couldn't play" feedback. A play-time failure
    // must surface via onTrackError (just like a download failure) and then skip.
    const onTrackError = vi.fn();
    const { ctrl, session } = makeController({ onTrackError });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    session.emit("error", new Error("Cannot demux: not an Ogg/WebM stream"));
    await new Promise((r) => setTimeout(r, 0));

    // Feedback surfaced for the FAILED track, then skipped to the next.
    expect(onTrackError).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: "aaaaaaaaaaa", title: "aaaaaaaaaaa" }),
    );
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
  });

  it("a FAILED (errored) track is NOT recorded in history as a played song", async () => {
    // A track that errored at play time never actually played, so it must not be archived
    // into history (which would let Replay re-add a song that just silently re-fails).
    const onTrackError = vi.fn();
    const { ctrl, session } = makeController({ onTrackError });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));

    session.emit("error", new Error("resource failed before playing"));
    await new Promise((r) => setTimeout(r, 0));

    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
    // The errored track 'aaaaaaaaaaa' must NOT be in history.
    expect(ctrl.snapshot().history.map((i) => i.meta.videoId)).not.toContain("aaaaaaaaaaa");
  });

  it("a clean trackEnd STILL advances AND records the played track in history", async () => {
    // The auto-advance + history behavior for a normally-finished track is preserved: a
    // clean Playing->Idle (trackEnd) means the song actually played, so it goes to history.
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    session.emit("trackEnd");
    await new Promise((r) => setTimeout(r, 0));

    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
    // A cleanly-finished song IS recorded in history.
    expect(ctrl.snapshot().history.map((i) => i.meta.videoId)).toContain("aaaaaaaaaaa");
  });

  it("error reason from a session error is forwarded to onTrackError", async () => {
    // The error's message becomes the human-facing reason on the panel banner.
    const onTrackError = vi.fn();
    const { ctrl, session } = makeController({ onTrackError });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));

    session.emit("error", new Error("ffmpeg exited 1"));
    await new Promise((r) => setTimeout(r, 0));

    expect(onTrackError).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining("ffmpeg exited 1") }),
    );
  });
});

describe("GuildController playback position + paused", () => {
  function makeClockController() {
    let t = 1000;
    const now = () => t;
    const session = new FakeSession();
    const cacheStore = new Map<string, string>();
    const audioStore = new Map<string, AudioInfo | null>();
    const makeResource = vi.fn((p: string, _item: unknown, opts?: { seekMs?: number }) => ({
      res: p,
      seekMs: opts?.seekMs ?? 0,
    }));
    const deps = {
      youtube: {
        download: vi.fn(async (id: string) => ({ path: `/cache/${id}.webm`, audio: AUDIO })),
      },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        getAudio: (id: string) => audioStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string, audio: AudioInfo | null = null) => {
          cacheStore.set(id, p);
          audioStore.set(id, audio);
        },
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => session as never),
      makeResource,
      prefetchDepth: 1,
      idleTimeoutMs: 300_000,
      downloads: new Semaphore(2),
      now,
    };
    const ctrl = new GuildController("G1", deps as never);
    return { ctrl, session, deps, makeResource, advanceClock: (ms: number) => (t += ms) };
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

  it("stop() after pause() clears the paused flag so the panel doesn't stick showing 'paused'", async () => {
    const { ctrl } = makeClockController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.pause();
    expect(ctrl.snapshot().paused).toBe(true);
    await ctrl.stop();
    // Without resetting pausedAt in stop(), isPaused would stay true over an empty queue.
    expect(ctrl.snapshot().paused).toBe(false);
    expect(ctrl.snapshot().current).toBeNull();
  });

  describe("GuildController.seek", () => {
    it("re-creates the resource at the offset, re-anchors position, and broadcasts", async () => {
      const { ctrl, session, makeResource, advanceClock } = makeClockController();
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));
      makeResource.mockClear();
      session.play.mockClear();
      const changed = vi.fn();
      ctrl.on("changed", changed);

      advanceClock(5000); // 5s into the track before seeking
      const ok = await ctrl.seek(30_000);
      expect(ok).toBe(true);
      // Resource re-created with the seek offset (and current audio options) and replayed.
      expect(makeResource).toHaveBeenCalledTimes(1);
      expect(makeResource.mock.calls[0]![2]).toEqual({
        seekMs: 30_000,
        audio: { crossfadeSec: 0, normalizeLoudness: false, fx: "none", volumePct: 100 },
      });
      expect(session.play).toHaveBeenCalledTimes(1);
      // Position re-anchored to the seek target.
      expect(ctrl.snapshot().current?.positionMs).toBe(30_000);
      expect(ctrl.snapshot().paused).toBe(false);
      // Broadcast fired so the panel re-renders.
      expect(changed).toHaveBeenCalled();

      advanceClock(2000); // 2s after the seek
      expect(ctrl.snapshot().current?.positionMs).toBe(32_000);
    });

    it("seeking while paused leaves the track paused at the new offset", async () => {
      const { ctrl, advanceClock } = makeClockController();
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));
      ctrl.pause();
      await ctrl.seek(20_000);
      expect(ctrl.snapshot().paused).toBe(true);
      expect(ctrl.snapshot().current?.positionMs).toBe(20_000);
      advanceClock(5000); // time passes while paused -> position stays frozen
      expect(ctrl.snapshot().current?.positionMs).toBe(20_000);
    });

    it("returns false when nothing is playing", async () => {
      const { ctrl, session } = makeClockController();
      await ctrl.ensureConnected("C1");
      session.play.mockClear();
      expect(await ctrl.seek(1000)).toBe(false);
      expect(session.play).not.toHaveBeenCalled();
    });

    it("rejects an out-of-range position with RangeError", async () => {
      const { ctrl } = makeClockController();
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester); // durationSec 100 -> 100000ms
      await new Promise((r) => setTimeout(r, 0));
      await expect(ctrl.seek(-1)).rejects.toBeInstanceOf(RangeError);
      await expect(ctrl.seek(100_001)).rejects.toBeInstanceOf(RangeError);
    });
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
    const audioStore = new Map<string, AudioInfo | null>();
    const deps = {
      youtube: {
        download: vi.fn(async (id: string) => ({ path: `/cache/${id}.webm`, audio: AUDIO })),
      },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        getAudio: (id: string) => audioStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string, audio: AudioInfo | null = null) => {
          cacheStore.set(id, p);
          audioStore.set(id, audio);
        },
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(
        async (_channelId: string, _idleTimeoutMs?: number) => sessions[sessionIdx++] as never,
      ),
      makeResource: (p: string) => ({ res: p }),
      prefetchDepth: 1,
      idleTimeoutMs: 300_000,
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
    // The controller's idle timeout (300s from idleTimeoutMs) propagates to the new session.
    expect(deps.createSession.mock.calls.at(-1)?.[1]).toBe(300_000);
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
    const audioStore = new Map<string, AudioInfo | null>();
    const deps = {
      youtube: {
        download: vi.fn(async (id: string) => ({ path: `/cache/${id}.webm`, audio: AUDIO })),
      },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        getAudio: (id: string) => audioStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string, audio: AudioInfo | null = null) => {
          cacheStore.set(id, p);
          audioStore.set(id, audio);
        },
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async (_channelId: string) => sessionC2 as never),
      makeResource: (p: string) => ({ res: p }),
      prefetchDepth: 1,
      idleTimeoutMs: 300_000,
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
    const audioStore = new Map<string, AudioInfo | null>();
    const deps = {
      youtube: {
        download: vi.fn(async (id: string) => ({ path: `/cache/${id}.webm`, audio: AUDIO })),
      },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        getAudio: (id: string) => audioStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string, audio: AudioInfo | null = null) => {
          cacheStore.set(id, p);
          audioStore.set(id, audio);
        },
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

describe("GuildController settings", () => {
  it("defaults audio settings and validates patches via updateSettings", () => {
    const { ctrl } = makeController();
    expect(ctrl.settings.repeat).toBe("off");
    expect(ctrl.settings.crossfadeSec).toBe(0);
    expect(ctrl.settings.normalizeLoudness).toBe(false);

    const next = ctrl.updateSettings({ repeat: "all", crossfadeSec: 999, normalizeLoudness: true });
    expect(next.repeat).toBe("all");
    expect(next.crossfadeSec).toBe(12); // clamped to CROSSFADE_MAX_SEC
    expect(next.normalizeLoudness).toBe(true);
    expect(ctrl.settings).toEqual(next);
  });

  it("notifies onSettingsChange and emits 'changed' on update", () => {
    const { ctrl } = makeController();
    const onSettingsChange = vi.fn();
    (
      ctrl as unknown as { deps: { onSettingsChange?: typeof onSettingsChange } }
    ).deps.onSettingsChange = onSettingsChange;
    const changed = vi.fn();
    ctrl.on("changed", changed);
    ctrl.updateSettings({ repeat: "one" });
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ repeat: "one" }));
    expect(changed).toHaveBeenCalled();
  });

  it("passes crossfade/normalize audio options to makeResource", async () => {
    const { ctrl, makeResource } = makeController();
    ctrl.updateSettings({ crossfadeSec: 4, normalizeLoudness: true });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    const opts = makeResource.mock.calls[0]![2] as { audio?: unknown };
    expect(opts.audio).toEqual({
      crossfadeSec: 4,
      normalizeLoudness: true,
      fx: "none",
      volumePct: 100,
    });
  });

  it("repeat=one replays the current track on trackEnd (no advance)", async () => {
    const { ctrl, session } = makeController();
    ctrl.updateSettings({ repeat: "one" });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    session.emit("trackEnd");
    await new Promise((r) => setTimeout(r, 0));
    // Still the same current track; the next one stays queued.
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(ctrl.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]);
    expect(session.play).toHaveBeenCalledTimes(2); // initial + replay
  });

  it("repeat=all re-cycles the set when the queue empties", async () => {
    const { ctrl, session } = makeController();
    ctrl.updateSettings({ repeat: "all" });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));

    session.emit("trackEnd"); // a ends -> b
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");

    session.emit("trackEnd"); // b ends -> queue empty -> requeue history -> a plays again
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(session.startIdleTimer).not.toHaveBeenCalled();
  });

  it("snapshot carries the audio settings", () => {
    const { ctrl } = makeController();
    ctrl.updateSettings({ crossfadeSec: 6, normalizeLoudness: true, repeat: "all" });
    const snap = ctrl.snapshot();
    expect(snap.crossfadeSec).toBe(6);
    expect(snap.normalizeLoudness).toBe(true);
    expect(snap.repeat).toBe("all");
  });

  it("snapshot carries the autoplay setting", () => {
    const { ctrl } = makeController();
    expect(ctrl.snapshot().autoplay).toBe(false);
    ctrl.updateSettings({ autoplay: true });
    expect(ctrl.snapshot().autoplay).toBe(true);
  });

  describe("autoplay (YouTube radio)", () => {
    it("auto-enqueues a related track when the queue empties and autoplay is ON", async () => {
      const { ctrl, session, related } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [meta("rrrrrrrrrrr"), meta("sssssssssss")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));
      expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

      session.emit("trackEnd"); // queue empties -> autoplay kicks in
      await new Promise((r) => setTimeout(r, 0));

      // related() was asked for the LAST played video id, and a related track now plays.
      expect(related).toHaveBeenCalledWith("aaaaaaaaaaa");
      expect(ctrl.snapshot().current?.meta.videoId).toBe("rrrrrrrrrrr");
      // The synthetic requester marks this as an autoplay pick.
      expect(ctrl.snapshot().current?.requester.source).toBe("autoplay");
      expect(session.startIdleTimer).not.toHaveBeenCalled();
    });

    it("does NOT auto-enqueue when autoplay is OFF (idles as before)", async () => {
      const { ctrl, session, related } = makeController({
        settings: { autoplay: false },
        relatedFn: async () => [meta("rrrrrrrrrrr")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      expect(related).not.toHaveBeenCalled();
      expect(ctrl.snapshot().current).toBeNull();
      expect(session.startIdleTimer).toHaveBeenCalled();
    });

    it("idles when autoplay is ON but related() returns nothing", async () => {
      const { ctrl, session, related } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      expect(related).toHaveBeenCalledWith("aaaaaaaaaaa");
      expect(ctrl.snapshot().current).toBeNull();
      expect(session.startIdleTimer).toHaveBeenCalled();
    });

    it("idles when related() throws (best-effort, never breaks playback)", async () => {
      const { ctrl, session } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => {
          throw new Error("yt-dlp blew up");
        },
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      expect(ctrl.snapshot().current).toBeNull();
      expect(session.startIdleTimer).toHaveBeenCalled();
    });

    it("skips related ids already seen this session (no immediate repeat of the seed chain)", async () => {
      // First radio pull returns the just-played track + a fresh one; the played id must
      // be filtered so autoplay advances rather than replaying history.
      const { ctrl, session } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [meta("aaaaaaaaaaa"), meta("rrrrrrrrrrr")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      expect(ctrl.snapshot().current?.meta.videoId).toBe("rrrrrrrrrrr");
    });

    it("idles when related() returns only already-seen ids (no new candidate to play)", async () => {
      // related() always returns ONLY ids that have already been played. After the seed
      // track, every radio pull yields nothing new, so the seen-id de-dup keeps autoplay
      // from ever queueing a track and the queue idles — even though the proactive
      // low-water path also consults related() while upcoming is empty.
      const played = new Set<string>();
      const { ctrl, session, related } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [...played].map((id) => meta(id)),
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));
      played.add("aaaaaaaaaaa");

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      // Nothing new to play -> idle. related() was consulted (de-dup filtered every id), but
      // a BOUNDED number of times — the seen-id de-dup + chain cap stop it spinning.
      expect(ctrl.snapshot().current).toBeNull();
      expect(session.startIdleTimer).toHaveBeenCalled();
      expect(related.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(related.mock.calls.length).toBeLessThanOrEqual(AUTOPLAY_MAX_CHAIN + 1);
    });

    it("caps consecutive autoplay enqueues at AUTOPLAY_MAX_CHAIN even when fresh ids keep arriving", async () => {
      // related() ALWAYS yields a brand-new, never-seen id, so the seen-id de-dup never
      // stops the chain — only the AUTOPLAY_MAX_CHAIN guard can. Each trackEnd drives one
      // autoplay enqueue+play; after exactly the cap is reached, the next trackEnd must
      // idle instead of enqueuing, despite a fresh candidate still being available.
      let n = 0;
      const freshId = () => `auto${String(n++).padStart(7, "0")}`;
      const { ctrl, session, related } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [meta(freshId())],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      // Drive autoplay until it stops. The chain caps at AUTOPLAY_MAX_CHAIN enqueues; the
      // (cap+1)-th trackEnd should find autoplayChain >= cap and idle.
      for (let i = 0; i < AUTOPLAY_MAX_CHAIN + 5; i++) {
        if (ctrl.snapshot().current === null) break;
        session.emit("trackEnd");
        await new Promise((r) => setTimeout(r, 0));
      }

      // Autoplay stopped at the cap: current is null and the idle timer started.
      expect(ctrl.snapshot().current).toBeNull();
      expect(session.startIdleTimer).toHaveBeenCalled();
      // related() was consulted for each enqueue (AUTOPLAY_MAX_CHAIN) plus the final pull
      // that hit the cap before enqueuing — bounded, never unbounded.
      expect(related.mock.calls.length).toBe(AUTOPLAY_MAX_CHAIN);
    });

    it("uses related() (not artistTracks) when autoplaySource is 'radio'", async () => {
      const { ctrl, session, related, artistTracks } = makeController({
        settings: { autoplay: true, autoplaySource: "radio" },
        relatedFn: async () => [meta("rrrrrrrrrrr")],
        artistTracksFn: async () => [meta("zzzzzzzzzzz")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      expect(related).toHaveBeenCalledWith("aaaaaaaaaaa");
      expect(artistTracks).not.toHaveBeenCalled();
      expect(ctrl.snapshot().current?.meta.videoId).toBe("rrrrrrrrrrr");
    });

    it("uses artistTracks() (not related) when autoplaySource is 'artist', seeded by the last track meta", async () => {
      const { ctrl, session, related, artistTracks } = makeController({
        settings: { autoplay: true, autoplaySource: "artist" },
        relatedFn: async () => [meta("rrrrrrrrrrr")],
        artistTracksFn: async () => [meta("zzzzzzzzzzz")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      // artistTracks is seeded with the LAST played track's full meta, not just its id.
      expect(artistTracks).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: "aaaaaaaaaaa" }),
      );
      expect(related).not.toHaveBeenCalled();
      expect(ctrl.snapshot().current?.meta.videoId).toBe("zzzzzzzzzzz");
      expect(ctrl.snapshot().current?.requester.source).toBe("autoplay");
    });

    it("PROACTIVE: tops up the queue when upcoming runs LOW (<=1) without waiting for empty", async () => {
      // Two user tracks queued; once the FIRST starts playing, upcoming has just one
      // track left (<=1) — that should already trigger a best-effort autoplay top-up so
      // there's no gap when the user queue drains.
      const { ctrl, related } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [meta("rrrrrrrrrrr")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
      await new Promise((r) => setTimeout(r, 0));

      // a is current, b is the single upcoming track -> LOW -> top-up fired.
      expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
      await new Promise((r) => setTimeout(r, 0));
      expect(related).toHaveBeenCalledWith("aaaaaaaaaaa");
      // The autoplay top-up appended a related track to upcoming (no advance/skip).
      expect(ctrl.snapshot().upcoming.map((i) => i.meta.videoId)).toContain("rrrrrrrrrrr");
    });

    it("PROACTIVE: does NOT top up when upcoming is low but autoplay is OFF", async () => {
      const { ctrl, related } = makeController({
        settings: { autoplay: false },
        relatedFn: async () => [meta("rrrrrrrrrrr")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
      await new Promise((r) => setTimeout(r, 0));

      expect(related).not.toHaveBeenCalled();
      // Only the two user tracks: a current, b upcoming. Nothing appended.
      expect(ctrl.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]);
    });

    it("PROACTIVE: the low-water top-up still honors the seen-id de-dup", async () => {
      // related echoes the already-playing id + a fresh one; the played id must be filtered
      // out of the proactive top-up just like the empty-queue path.
      const { ctrl } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [meta("aaaaaaaaaaa"), meta("rrrrrrrrrrr")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
      await new Promise((r) => setTimeout(r, 0));

      const up = ctrl.snapshot().upcoming.map((i) => i.meta.videoId);
      // The seed id is NOT re-appended; only the fresh related id is.
      expect(up).toContain("rrrrrrrrrrr");
      expect(up.filter((id) => id === "aaaaaaaaaaa")).toHaveLength(0);
    });

    it("PROACTIVE: a real user enqueue resets the autoplay chain so a fresh cap applies", async () => {
      // Drive autoplay (via trackEnd) until the chain caps and the queue idles, then prove a
      // real user enqueue resets autoplayChain to 0 so autoplay can resume from a clean cap.
      let n = 0;
      const freshId = () => `auto${String(n++).padStart(7, "0")}`;
      const { ctrl, session, related } = makeController({
        settings: { autoplay: true },
        relatedFn: async () => [meta(freshId())],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      // Skip through tracks until autoplay caps out and the queue idles (current === null).
      for (let i = 0; i < AUTOPLAY_MAX_CHAIN + 10; i++) {
        if (ctrl.snapshot().current === null) break;
        session.emit("trackEnd");
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(ctrl.snapshot().current).toBeNull(); // chain cap reached -> idled
      const cappedCalls = related.mock.calls.length;

      // A real user enqueue resets the chain budget (autoplayChain -> 0) AND starts playing.
      await ctrl.enqueue(meta("ccccccccccc"), requester);
      await new Promise((r) => setTimeout(r, 0));
      expect(ctrl.snapshot().current?.meta.videoId).toBe("ccccccccccc");

      // With the chain reset, autoplay tops up again off the user track — more related()
      // pulls happen that the prior cap would otherwise have forbidden.
      await new Promise((r) => setTimeout(r, 0));
      expect(related.mock.calls.length).toBeGreaterThan(cappedCalls);
      expect(ctrl.snapshot().upcoming.length).toBeGreaterThan(0); // fresh top-up landed
    });

    it("artist source reuses the same seen-id de-dup + idle fallback", async () => {
      // artistTracks echoes the already-played id + one fresh id; the played one is filtered.
      const { ctrl, session } = makeController({
        settings: { autoplay: true, autoplaySource: "artist" },
        artistTracksFn: async () => [meta("aaaaaaaaaaa"), meta("zzzzzzzzzzz")],
      });
      await ctrl.ensureConnected("C1");
      await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
      await new Promise((r) => setTimeout(r, 0));

      session.emit("trackEnd");
      await new Promise((r) => setTimeout(r, 0));

      expect(ctrl.snapshot().current?.meta.videoId).toBe("zzzzzzzzzzz");
    });
  });
});

describe("GuildController volume + fx", () => {
  // A controller whose makeResource returns a resource carrying an inline-volume knob
  // (a setVolume spy) so we can assert live volume re-application vs re-resourcing.
  function makeVolController(settings?: Partial<import("./settings.js").GuildSettings>) {
    let t = 1000;
    const now = () => t;
    const session = new FakeSession();
    const cacheStore = new Map<string, string>();
    const audioStore = new Map<string, AudioInfo | null>();
    // Each resource gets its own setVolume spy; we capture the latest so tests can assert.
    const setVolumeSpies: ReturnType<typeof vi.fn>[] = [];
    const makeResource = vi.fn(
      (p: string, _item: unknown, opts?: { seekMs?: number; audio?: { volumePct?: number } }) => {
        const setVolume = vi.fn();
        setVolumeSpies.push(setVolume);
        // Mirror the real factory: only a non-100 volume yields an inline-volume knob.
        const hasInline = (opts?.audio?.volumePct ?? 100) !== 100;
        return { res: p, seekMs: opts?.seekMs ?? 0, volume: hasInline ? { setVolume } : null };
      },
    );
    const deps = {
      youtube: {
        download: vi.fn(async (id: string) => ({ path: `/cache/${id}.webm`, audio: AUDIO })),
      },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        getAudio: (id: string) => audioStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string, audio: AudioInfo | null = null) => {
          cacheStore.set(id, p);
          audioStore.set(id, audio);
        },
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => session as never),
      makeResource,
      prefetchDepth: 1,
      idleTimeoutMs: 300_000,
      downloads: new Semaphore(2),
      now,
      settings: settings ? { ...DEFAULT_SETTINGS, ...settings } : undefined,
    };
    const ctrl = new GuildController("G1", deps as never);
    return {
      ctrl,
      session,
      makeResource,
      setVolumeSpies,
      advanceClock: (ms: number) => (t += ms),
    };
  }

  it("defaults volume to 100 and fx to none in the snapshot", () => {
    const { ctrl } = makeVolController();
    expect(ctrl.snapshot().volume).toBe(100);
    expect(ctrl.snapshot().fx).toBe("none");
  });

  it("starts a non-100 track with inline volume applied from the first frame", async () => {
    const { ctrl, setVolumeSpies, makeResource } = makeVolController({ volume: 50 });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    // The resource was built with volumePct 50 → inline volume set to 0.5.
    expect(makeResource.mock.calls[0]![2]).toMatchObject({ audio: { volumePct: 50 } });
    expect(setVolumeSpies[0]).toHaveBeenCalledWith(0.5);
  });

  it("setVolume re-applies live (no re-resource) when staying non-100", async () => {
    const { ctrl, makeResource, setVolumeSpies } = makeVolController({ volume: 80 });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    makeResource.mockClear();
    // 80 → 120: both non-100, the current resource has an inline knob → live re-apply.
    ctrl.setVolume(120);
    await new Promise((r) => setTimeout(r, 0));
    expect(makeResource).not.toHaveBeenCalled();
    expect(setVolumeSpies[0]).toHaveBeenLastCalledWith(1.2);
    expect(ctrl.snapshot().volume).toBe(120);
  });

  it("setVolume re-resources at the current position when crossing 100 (passthrough ⇄ inline)", async () => {
    const { ctrl, makeResource, advanceClock } = makeVolController({ volume: 100 });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    makeResource.mockClear();
    advanceClock(7000); // 7s into the track
    ctrl.setVolume(150);
    await new Promise((r) => setTimeout(r, 0));
    // 100 → 150 flips passthrough→inline: the resource is rebuilt at the 7s offset.
    expect(makeResource).toHaveBeenCalledTimes(1);
    expect(makeResource.mock.calls[0]![2]).toMatchObject({
      seekMs: 7000,
      audio: { volumePct: 150 },
    });
    expect(ctrl.snapshot().current?.positionMs).toBe(7000);
  });

  it("setFx re-resources at the current position with the new preset baked in", async () => {
    const { ctrl, makeResource, advanceClock } = makeVolController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    makeResource.mockClear();
    advanceClock(3000);
    ctrl.setFx("nightcore");
    await new Promise((r) => setTimeout(r, 0));
    expect(makeResource).toHaveBeenCalledTimes(1);
    expect(makeResource.mock.calls[0]![2]).toMatchObject({
      seekMs: 3000,
      audio: { fx: "nightcore" },
    });
    expect(ctrl.snapshot().fx).toBe("nightcore");
  });

  it("setFx while paused keeps the track paused at the same position after re-resource", async () => {
    const { ctrl, session, advanceClock } = makeVolController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    advanceClock(4000);
    ctrl.pause();
    session.pause.mockClear();
    ctrl.setFx("bassboost");
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().paused).toBe(true);
    expect(ctrl.snapshot().current?.positionMs).toBe(4000);
    // The fresh resource was re-paused after play.
    expect(session.pause).toHaveBeenCalled();
  });

  it("does not re-resource when an unrelated setting changes", async () => {
    const { ctrl, makeResource } = makeVolController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    makeResource.mockClear();
    ctrl.updateSettings({ repeat: "all" });
    await new Promise((r) => setTimeout(r, 0));
    expect(makeResource).not.toHaveBeenCalled();
  });

  it("clears currentResource when the queue runs dry naturally (no stale inline-volume re-apply)", async () => {
    const { ctrl, session, setVolumeSpies } = makeVolController({ volume: 50 });
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    // The first (and only) track started with an inline-volume knob (volume 50).
    expect(setVolumeSpies).toHaveLength(1);

    // Queue runs dry NATURALLY: the track ends, playNextLocked finds nothing and idles.
    session.emit("trackEnd");
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current).toBeNull();
    expect(session.startIdleTimer).toHaveBeenCalled();

    // currentResource must have been nulled on the natural-idle path. If it were stale,
    // a non-100→non-100 volume change would take the live re-apply branch and call the
    // OLD resource's setVolume spy. With it cleared, that branch is skipped (re-resource
    // path is a no-op since nothing is playing), so the spy is never called again.
    setVolumeSpies[0]!.mockClear();
    ctrl.setVolume(120);
    await new Promise((r) => setTimeout(r, 0));
    expect(setVolumeSpies[0]).not.toHaveBeenCalled();
  });
});

describe("GuildController preparing (live download/processing status)", () => {
  // A controller whose download + makeResource can be paused mid-flight so we can observe
  // the intermediate `preparing` phases (resolving → downloading → processing → null).
  function makeDeferredController(opts: { onProgressCalls?: number[][] } = {}) {
    const session = new FakeSession();
    const cacheStore = new Map<string, string>();
    const audioStore = new Map<string, AudioInfo | null>();
    // Gate the download: it resolves only when `releaseDownload()` is called, after
    // optionally replaying a scripted set of onProgress percents.
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((r) => (releaseDownload = r));
    const download = vi.fn(
      async (
        id: string,
        _dir: string,
        o?: { durationSec?: number | null; onProgress?: (p: { percent: number }) => void },
      ) => {
        for (const [pct] of opts.onProgressCalls ?? []) o?.onProgress?.({ percent: pct! });
        await downloadGate;
        return { path: `/cache/${id}.webm`, audio: AUDIO };
      },
    );
    let releaseResource!: () => void;
    const resourceGate = new Promise<void>((r) => (releaseResource = r));
    const makeResource = vi.fn(async (p: string) => {
      await resourceGate;
      return { res: p };
    });
    const deps = {
      youtube: { download, related: vi.fn(async () => []), artistTracks: vi.fn(async () => []) },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        getAudio: (id: string) => audioStore.get(id) ?? null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string, audio: AudioInfo | null = null) => {
          cacheStore.set(id, p);
          audioStore.set(id, audio);
        },
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => session as never),
      makeResource,
      prefetchDepth: 0, // disable prefetch so it doesn't pre-cache and skip downloading
      idleTimeoutMs: 300_000,
      downloads: new Semaphore(2),
    };
    const ctrl = new GuildController("G1", deps as never);
    return { ctrl, session, deps, download, makeResource, releaseDownload, releaseResource };
  }

  it("snapshot carries preparing=null when idle", () => {
    const { ctrl } = makeDeferredController();
    expect(ctrl.snapshot().preparing).toBeNull();
  });

  it("walks preparing through downloading → processing → null as a track is fetched and started", async () => {
    const { ctrl, deps, releaseDownload, releaseResource } = makeDeferredController();
    await ctrl.ensureConnected("C1");
    void ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    // Let enqueue → maybeStart → playItemLocked reach the (gated) download.
    await new Promise((r) => setTimeout(r, 0));

    // Downloading: a fresh, uncached track is being fetched.
    let prep = ctrl.snapshot().preparing;
    expect(prep).toMatchObject({
      videoId: "aaaaaaaaaaa",
      title: "aaaaaaaaaaa",
      phase: "downloading",
    });

    // Release the download → it advances to processing (makeResource is still gated).
    releaseDownload();
    await new Promise((r) => setTimeout(r, 0));
    prep = ctrl.snapshot().preparing;
    expect(prep).toMatchObject({ phase: "processing" });
    // The playback path invoked download for this track (prefetch may also call it for the
    // next item — we only assert the playback fetch happened).
    expect(deps.youtube.download).toHaveBeenCalledWith(
      "aaaaaaaaaaa",
      "/cache",
      expect.objectContaining({ durationSec: 100 }),
    );

    // Release makeResource → the track starts playing and preparing clears.
    releaseResource();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().preparing).toBeNull();
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
  });

  it("forwards download progress percent into preparing.percent", async () => {
    const { ctrl, releaseDownload, releaseResource } = makeDeferredController({
      onProgressCalls: [[42]],
    });
    await ctrl.ensureConnected("C1");
    void ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().preparing).toMatchObject({ phase: "downloading", percent: 42 });
    releaseDownload();
    releaseResource();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("passes the track durationSec into youtube.download (for timeout scaling)", async () => {
    const { ctrl, download, releaseDownload, releaseResource } = makeDeferredController();
    await ctrl.ensureConnected("C1");
    void ctrl.enqueue(meta("aaaaaaaaaaa"), requester); // meta() sets durationSec: 100
    await new Promise((r) => setTimeout(r, 0));
    releaseDownload();
    releaseResource();
    await new Promise((r) => setTimeout(r, 0));
    expect(download).toHaveBeenCalledWith(
      "aaaaaaaaaaa",
      "/cache",
      expect.objectContaining({ durationSec: 100 }),
    );
  });

  it("clears preparing (null) and reports the error when a download fails", async () => {
    const onTrackError = vi.fn();
    const session = new FakeSession();
    const deps = {
      youtube: {
        download: vi.fn(async () => {
          throw new Error("network died");
        }),
        related: vi.fn(async () => []),
        artistTracks: vi.fn(async () => []),
      },
      cache: {
        get: () => null,
        getAudio: () => null,
        has: () => false,
        register: vi.fn(),
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => session as never),
      makeResource: vi.fn(),
      prefetchDepth: 0,
      idleTimeoutMs: 300_000,
      downloads: new Semaphore(2),
      onTrackError,
    };
    const ctrl = new GuildController("G1", deps as never);
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(onTrackError).toHaveBeenCalled();
    expect(ctrl.snapshot().preparing).toBeNull();
    expect(ctrl.snapshot().current).toBeNull();
  });

  it("throttles percent broadcasts: small advances don't emit, ≥5% does", async () => {
    // Drive onProgress with a scripted set of percents; capture each preparing.percent at
    // every 'changed' emission. The throttle should suppress sub-5% advances.
    const captured: (number | undefined)[] = [];
    const session = new FakeSession();
    const cacheStore = new Map<string, string>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps = {
      youtube: {
        download: vi.fn(
          async (
            id: string,
            _dir: string,
            o?: { onProgress?: (p: { percent: number }) => void },
          ) => {
            // 0 (phase set) → 2 (suppressed) → 6 (emit) → 7 (suppressed) → 100 (emit)
            for (const p of [0, 2, 6, 7, 100]) o?.onProgress?.({ percent: p });
            await gate;
            return { path: `/cache/${id}.webm`, audio: AUDIO };
          },
        ),
        related: vi.fn(async () => []),
        artistTracks: vi.fn(async () => []),
      },
      cache: {
        get: (id: string) => cacheStore.get(id) ?? null,
        getAudio: () => null,
        has: (id: string) => cacheStore.has(id),
        register: (id: string, p: string) => cacheStore.set(id, p),
        pin: vi.fn(),
        unpin: vi.fn(),
      },
      cacheDir: "/cache",
      createSession: vi.fn(async () => session as never),
      makeResource: vi.fn(async (p: string) => ({ res: p })),
      prefetchDepth: 0,
      idleTimeoutMs: 300_000,
      downloads: new Semaphore(2),
    };
    const ctrl = new GuildController("G1", deps as never);
    await ctrl.ensureConnected("C1");
    ctrl.on("changed", () => {
      const prep = ctrl.snapshot().preparing;
      if (prep?.phase === "downloading") captured.push(prep.percent);
    });
    void ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await new Promise((r) => setTimeout(r, 0));
    // 2 and 7 must be throttled out; 0 (initial), 6, and 100 survive (each ≥5% from prior).
    expect(captured).toContain(6);
    expect(captured).toContain(100);
    expect(captured).not.toContain(2);
    expect(captured).not.toContain(7);
  });
});
