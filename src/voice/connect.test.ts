import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ── Mock @discordjs/voice ─────────────────────────────────────────────────────────────
// We only exercise the resource-creation path, so stub demuxProbe / createAudioResource and
// expose the StreamType enum values createPassthroughResource references.
const demuxProbeMock = vi.hoisted(() => vi.fn());
const createAudioResourceMock = vi.hoisted(() => vi.fn());
vi.mock("@discordjs/voice", () => ({
  demuxProbe: demuxProbeMock,
  createAudioResource: createAudioResourceMock,
  // Unused by these tests but imported by the module under test.
  joinVoiceChannel: vi.fn(),
  entersState: vi.fn(),
  createAudioPlayer: vi.fn(),
  NoSubscriberBehavior: { Pause: "pause" },
  StreamType: { Raw: "raw", OggOpus: "ogg/opus", Arbitrary: "arbitrary", WebmOpus: "webm/opus" },
  VoiceConnectionStatus: { Ready: "ready" },
}));

// ── Mock child_process.spawn (ffmpeg) ─────────────────────────────────────────────────
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// ── Mock fs.createReadStream (no real file IO) ────────────────────────────────────────
vi.mock("node:fs", () => ({ createReadStream: vi.fn(() => new PassThrough()) }));

import { createPassthroughResource } from "./connect.js";
import type { QueueItem } from "../types/index.js";

function fakeFfmpeg() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.exitCode = null;
  return proc;
}

const item = {
  meta: { videoId: "v", title: "t", channel: "c", durationSec: 100, isLive: false },
} as unknown as QueueItem;

describe("createPassthroughResource", () => {
  beforeEach(() => {
    demuxProbeMock.mockReset();
    createAudioResourceMock.mockReset();
    spawnMock.mockReset();
    createAudioResourceMock.mockImplementation((stream, opts) => ({ stream, opts }));
    spawnMock.mockReturnValue(fakeFfmpeg());
  });

  it("uses Opus passthrough (no ffmpeg) for a probable Opus file at default settings", async () => {
    demuxProbeMock.mockResolvedValue({ stream: new PassThrough(), type: "webm/opus" });
    await createPassthroughResource("/cache/v.webm", item);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(createAudioResourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ inputType: "webm/opus" }),
    );
  });

  it("falls back to an ffmpeg transcode when demuxProbe throws (non-opus/unclassifiable file)", async () => {
    // A downloaded m4a/AAC (or any container demuxProbe can't classify as Ogg/WebM-Opus)
    // makes the probe throw. Instead of producing a resource that immediately errors on play
    // (→ silent skip), fall back to an ffmpeg transcode so the track still plays.
    demuxProbeMock.mockRejectedValue(new Error("Failed to probe stream"));
    const resource = await createPassthroughResource("/cache/v.m4a", item);
    expect(resource).toBeDefined();
    // ffmpeg was spawned for the transcode fallback.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(spawnMock.mock.calls[0]![0]).toBe("ffmpeg");
    expect(args).toContain("/cache/v.m4a");
    // Fallback emits Ogg/Opus (passthrough-equivalent), not raw PCM (no inline volume here).
    expect(args).toContain("libopus");
  });
});
