import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { VoiceSession } from "./session.js";

// Fakes mirroring the subset of @discordjs/voice we use.
class FakePlayer extends EventEmitter {
  play = vi.fn();
  pause = vi.fn(() => true);
  unpause = vi.fn(() => true);
  stop = vi.fn(() => true);
  // helper to simulate a state transition
  transition(oldStatus: string, newStatus: string) {
    this.emit("stateChange", { status: oldStatus }, { status: newStatus });
  }
}
class FakeConnection extends EventEmitter {
  destroy = vi.fn();
  state = { status: "ready" };
}

function makeSession(idleMs = 1000) {
  const player = new FakePlayer();
  const conn = new FakeConnection();
  const session = new VoiceSession(conn as never, player as never, {
    channelId: "C1",
    idleTimeoutMs: idleMs,
  });
  return { session, player, conn };
}

describe("VoiceSession", () => {
  beforeEach(() => vi.useRealTimers());

  it("emits trackEnd when the player goes Playing -> Idle", () => {
    const { session, player } = makeSession();
    const onEnd = vi.fn();
    session.on("trackEnd", onEnd);
    player.transition("buffering", "playing"); // not an end
    player.transition("playing", "idle"); // end
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("does not emit trackEnd on an Idle->Idle (startup) transition", () => {
    const { session, player } = makeSession();
    const onEnd = vi.fn();
    session.on("trackEnd", onEnd);
    player.transition("idle", "idle");
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("forwards player errors", () => {
    const { session, player } = makeSession();
    const onErr = vi.fn();
    session.on("error", onErr);
    const err = new Error("decode failed");
    player.emit("error", err);
    expect(onErr).toHaveBeenCalledWith(err);
  });

  it("play/pause/resume/skip/stop delegate to the player with the right force flag", () => {
    const { session, player } = makeSession();
    const res = {} as never;
    session.play(res);
    expect(player.play).toHaveBeenCalledWith(res);
    session.pause();
    expect(player.pause).toHaveBeenCalled();
    session.resume();
    expect(player.unpause).toHaveBeenCalled();
    // skip() = player.stop() WITHOUT force (honors silence padding). A collapse of skip into
    // stop would pass force=true and be caught here.
    session.skip();
    expect(player.stop).toHaveBeenLastCalledWith();
    // stop() = player.stop(true) (force, bypasses padding) — semantically distinct from skip().
    session.stop();
    expect(player.stop).toHaveBeenLastCalledWith(true);
  });

  it("keeps a permanent error listener so a stray error after destroy can't crash the process", () => {
    // AudioPlayer has no internal self-listener; a listener-less "error" is converted by Node
    // into an unhandled exception (process crash). The session attaches a permanent noop guard
    // that is NEVER removed, so even after destroy() detaches the forwarding listener the
    // player always retains an "error" handler. Emitting "error" after destroy must NOT throw.
    const { session, player } = makeSession();
    session.destroy();
    expect(() => player.emit("error", new Error("stray after destroy"))).not.toThrow();
    expect(player.listenerCount("error")).toBeGreaterThanOrEqual(1);
  });

  it("destroy removes the forwarding listeners so the session no longer reacts", () => {
    // After destroy() the session must not fire trackEnd/error onto its (now-stale) consumer —
    // critical for the moveTo/reconnect flow where a torn-down session's player must not drive
    // the new session's controller. (The permanent error guard remains, so emit("error") is safe.)
    const { session, player } = makeSession();
    const onEnd = vi.fn();
    const onErr = vi.fn();
    session.on("trackEnd", onEnd);
    session.on("error", onErr);
    session.destroy();
    player.transition("playing", "idle");
    player.emit("error", new Error("x"));
    expect(onEnd).not.toHaveBeenCalled();
    expect(onErr).not.toHaveBeenCalled();
  });

  it("emits idle after the timeout, and cancel prevents it", () => {
    vi.useFakeTimers();
    const { session } = makeSession(1000);
    const onIdle = vi.fn();
    session.on("idle", onIdle);
    session.startIdleTimer();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);

    const onIdle2 = vi.fn();
    session.on("idle", onIdle2);
    session.startIdleTimer();
    session.cancelIdleTimer();
    vi.advanceTimersByTime(2000);
    expect(onIdle2).not.toHaveBeenCalled();
  });

  it("setIdleTimeout updates the timeout used by a future startIdleTimer", () => {
    vi.useFakeTimers();
    const { session } = makeSession(1000);
    const onIdle = vi.fn();
    session.on("idle", onIdle);
    session.setIdleTimeout(5000);
    session.startIdleTimer();
    vi.advanceTimersByTime(1000); // old timeout would have fired here
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000); // 5000 total
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("setIdleTimeout restarts a RUNNING idle timer with the new value (takes effect immediately)", () => {
    vi.useFakeTimers();
    const { session } = makeSession(1000);
    const onIdle = vi.fn();
    session.on("idle", onIdle);
    session.startIdleTimer();
    vi.advanceTimersByTime(500); // 500ms into the original 1000ms timer
    session.setIdleTimeout(3000); // restart with 3000ms from now
    vi.advanceTimersByTime(999); // original (1000) would have already fired without restart
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2001); // 3000 since restart
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("setIdleTimeout does NOT start a timer if one is not running", () => {
    vi.useFakeTimers();
    const { session } = makeSession(1000);
    const onIdle = vi.fn();
    session.on("idle", onIdle);
    session.setIdleTimeout(2000);
    vi.advanceTimersByTime(10000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("play() cancels the idle timer", () => {
    vi.useFakeTimers();
    const idleMs = 1000;
    const { session } = makeSession(idleMs);
    const onIdle = vi.fn();
    session.on("idle", onIdle);
    session.startIdleTimer();
    session.play({} as never);
    vi.advanceTimersByTime(idleMs + 10);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("destroy tears down the connection", () => {
    const { session, conn } = makeSession();
    session.destroy();
    expect(conn.destroy).toHaveBeenCalled();
  });

  it("destroy is idempotent — called twice invokes connection.destroy once", () => {
    const { session, conn } = makeSession();
    session.destroy();
    session.destroy();
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroy force-stops the player BEFORE destroying the connection (reaps ffmpeg)", () => {
    // Forcing the player Idle first makes @discordjs/voice destroy the resource's
    // playStream, which propagates to ff.stdout 'close' and triggers the SIGKILL reaper,
    // preventing orphaned ffmpeg children on mid-playback teardown.
    const { session, player, conn } = makeSession();
    const order: string[] = [];
    player.stop.mockImplementation(() => {
      order.push("stop");
      return true;
    });
    conn.destroy.mockImplementation(() => {
      order.push("destroy");
    });
    session.destroy();
    expect(player.stop).toHaveBeenCalledWith(true);
    expect(order).toEqual(["stop", "destroy"]);
  });

  it("destroy does NOT emit trackEnd (listener removed before the forced stop)", () => {
    const { session, player } = makeSession();
    const onEnd = vi.fn();
    session.on("trackEnd", onEnd);
    // Simulate the forced stop driving the player to idle on destroy.
    player.stop.mockImplementation(() => {
      player.transition("playing", "idle");
      return true;
    });
    session.destroy();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
