import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * The voice CONNECTION lifecycle — the half of connect.ts that decides whether a session that
 * has lost its connection gets torn down (so the controller rebuilds it on the next request) or
 * is left in place.
 *
 * This matters most for a bot SITTING IDLE in a channel: a silent voice connection is exactly
 * the one Discord drops, and `GuildController.ensureConnected()` short-circuits on
 * `if (this.session) return` — so a session left alive around a dead connection is never
 * replaced, and every later play is fed to a connection that cannot carry audio. The bot sits
 * in the channel and does nothing.
 */

const joinVoiceChannelMock = vi.hoisted(() => vi.fn());
const entersStateMock = vi.hoisted(() => vi.fn());
const createAudioPlayerMock = vi.hoisted(() => vi.fn());

// Hoisted with the vi.mock factory below, which is lifted above the imports.
const STATUS = vi.hoisted(() => ({
  Ready: "ready",
  Connecting: "connecting",
  Signalling: "signalling",
  Disconnected: "disconnected",
  Destroyed: "destroyed",
}));

vi.mock("@discordjs/voice", () => ({
  joinVoiceChannel: joinVoiceChannelMock,
  entersState: entersStateMock,
  createAudioPlayer: createAudioPlayerMock,
  createAudioResource: vi.fn(),
  demuxProbe: vi.fn(),
  NoSubscriberBehavior: { Pause: "pause" },
  StreamType: { Raw: "raw", OggOpus: "ogg/opus", Arbitrary: "arbitrary", WebmOpus: "webm/opus" },
  VoiceConnectionStatus: STATUS,
}));

vi.mock("discord.js", () => ({
  PermissionsBitField: { Flags: { ViewChannel: 1n, Connect: 2n, Speak: 4n } },
}));

import { createVoiceSession } from "./connect.js";
import { createLogger, setRootLogger } from "../util/logger.js";

type FakeConnection = EventEmitter & {
  state: { status: string };
  subscribe: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  /** Drive a status transition the way @discordjs/voice does. */
  go(status: string): void;
};

function fakeConnection(): FakeConnection {
  const c = new EventEmitter() as FakeConnection;
  c.state = { status: STATUS.Ready };
  c.subscribe = vi.fn();
  c.destroy = vi.fn(() => {
    c.state = { status: STATUS.Destroyed };
  });
  c.go = (status: string) => {
    const old = c.state;
    c.state = { status };
    c.emit("stateChange", old, c.state);
  };
  return c;
}

function fakePlayer(): EventEmitter & {
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const p = new EventEmitter() as EventEmitter & {
    play: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  p.play = vi.fn();
  p.stop = vi.fn();
  return p;
}

/** A channel whose guild has no `members.me`, so the permission pre-flight is skipped. */
const channel = {
  id: "VC1",
  guild: { id: "G1", members: { me: null }, voiceAdapterCreator: vi.fn() },
  permissionsFor: vi.fn(),
} as never;

let connection: FakeConnection;

beforeEach(() => {
  setRootLogger(createLogger("silent"));
  vi.useFakeTimers();
  joinVoiceChannelMock.mockReset();
  entersStateMock.mockReset();
  createAudioPlayerMock.mockReset();
  connection = fakeConnection();
  joinVoiceChannelMock.mockReturnValue(connection);
  createAudioPlayerMock.mockReturnValue(fakePlayer());
  // The initial join awaits Ready; every test starts from a healthy, connected session.
  entersStateMock.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Build a session and record whether it ever signalled that its connection died. */
async function connected(): Promise<{
  session: Awaited<ReturnType<typeof createVoiceSession>>;
  idle: () => number;
}> {
  const session = await createVoiceSession(channel, 300_000);
  let idleCount = 0;
  session.on("idle", () => {
    idleCount += 1;
  });
  return { session, idle: () => idleCount };
}

describe("a connection that is genuinely recovering is left alone", () => {
  it("does not tear the session down when the library reconnects to Ready", async () => {
    const { session, idle } = await connected();
    // Disconnected → the handler races Signalling/Connecting, which resolves (reconnecting).
    entersStateMock.mockResolvedValue(undefined);
    connection.go(STATUS.Disconnected);
    await vi.advanceTimersByTimeAsync(100);
    connection.go(STATUS.Ready);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idle()).toBe(0);
    expect(connection.destroy).not.toHaveBeenCalled();
    session.destroy();
  });
});

describe("a connection that is NOT recovering is torn down", () => {
  it("tears down when the reconnect race fails outright (a 4014 kick)", async () => {
    const { idle } = await connected();
    entersStateMock.mockRejectedValue(new Error("timed out"));
    connection.go(STATUS.Disconnected);
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.destroy).toHaveBeenCalled();
    expect(idle()).toBe(1);
  });

  it("tears down when the connection HANGS mid-reconnect and never reaches Ready", async () => {
    // THE IDLE-BOT BUG. Disconnected → Signalling resolves, so the handler concludes "the
    // library is recovering" and stops watching. If Ready never arrives — the connection sits
    // in Signalling/Connecting indefinitely, which is exactly what a dropped idle connection
    // does — nothing else is watching, so the session survives around a connection that can
    // never carry audio. ensureConnected() then short-circuits on the live session forever and
    // the bot sits in the channel doing nothing.
    const { idle } = await connected();
    entersStateMock.mockImplementation(async (_c: unknown, status: string) => {
      // The reconnect ATTEMPT starts (Signalling is reached)…
      if (status === STATUS.Signalling || status === STATUS.Connecting) return undefined;
      // …but Ready never arrives.
      throw new Error("timed out");
    });
    connection.go(STATUS.Disconnected);
    connection.go(STATUS.Signalling);

    // Give it far longer than any plausible reconnect. A connection still not Ready by now is
    // dead, and leaving it in place is what wedges the bot.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(idle()).toBe(1);
    expect(connection.destroy).toHaveBeenCalled();
  });
});
