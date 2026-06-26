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

  it("play/pause/resume/skip delegate to the player", () => {
    const { session, player } = makeSession();
    const res = {} as never;
    session.play(res);
    expect(player.play).toHaveBeenCalledWith(res);
    session.pause();
    expect(player.pause).toHaveBeenCalled();
    session.resume();
    expect(player.unpause).toHaveBeenCalled();
    session.skip();
    expect(player.stop).toHaveBeenCalled();
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
});
