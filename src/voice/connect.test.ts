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

  it("seeks via ffmpeg -ss placed BEFORE -i with millisecond precision", async () => {
    // seekMs > 0 forces the transcode path and emits `-ss <sec>` as an INPUT seek (before -i).
    await createPassthroughResource("/cache/v.webm", item, { seekMs: 5000 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe("ffmpeg");
    const args = spawnMock.mock.calls[0]![1] as string[];
    const ss = args.indexOf("-ss");
    const i = args.indexOf("-i");
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(ss).toBeLessThan(i); // input seek: -ss must precede -i
    expect(args[ss + 1]).toBe("5.000"); // (seekMs/1000).toFixed(3)
    // With seekMs>0 the probe is skipped entirely.
    expect(demuxProbeMock).not.toHaveBeenCalled();
  });

  it("transcodes with an -af chain when audio post-processing is requested (loudnorm)", async () => {
    // normalizeLoudness forces the transcode before any probe; assert the ffmpeg -af wiring.
    const resource = await createPassthroughResource("/cache/v.webm", item, {
      audio: { normalizeLoudness: true, crossfadeSec: 0, fx: "none", volumePct: 100 },
    });
    expect(resource).toBeDefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0]! as [string, string[]];
    expect(cmd).toBe("ffmpeg");
    const afIdx = args.indexOf("-af");
    expect(afIdx).toBeGreaterThanOrEqual(0);
    expect(args[afIdx + 1]).toContain("loudnorm");
    // The audio path bypasses the demux probe.
    expect(demuxProbeMock).not.toHaveBeenCalled();
  });

  it("uses the raw-PCM (s16le) ffmpeg path with inline volume for a non-100 volume", async () => {
    // volumePct !== 100 enables inline volume, which requires raw PCM (no Opus passthrough).
    await createPassthroughResource("/cache/v.webm", item, {
      audio: { normalizeLoudness: false, crossfadeSec: 0, fx: "none", volumePct: 80 },
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]![1] as string[];
    // Raw PCM format args, NOT libopus.
    expect(args).toContain("-f");
    expect(args).toContain("s16le");
    expect(args).toContain("-ar");
    expect(args).toContain("48000");
    expect(args).toContain("-ac");
    expect(args).toContain("2");
    expect(args).not.toContain("libopus");
    // createAudioResource is invoked with the raw StreamType + inlineVolume enabled.
    expect(createAudioResourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ inputType: "raw", inlineVolume: true }),
    );
  });

  it("reaps the ffmpeg child when its stdout closes (consumer done with the stream)", async () => {
    const proc = fakeFfmpeg();
    spawnMock.mockReturnValue(proc);
    await createPassthroughResource("/cache/v.m4a", item, { seekMs: 5000 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();
    // Stream finished/torn down without the process having exited yet → SIGKILL the orphan.
    proc.stdout.emit("close");
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not SIGKILL a child whose process already exited when stdout closes", async () => {
    const proc = fakeFfmpeg();
    spawnMock.mockReturnValue(proc);
    await createPassthroughResource("/cache/v.m4a", item, { seekMs: 5000 });
    proc.exitCode = 0; // process already gone
    proc.stdout.emit("close");
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("watchdog SIGKILLs a transcode child whose output is never consumed", async () => {
    vi.useFakeTimers();
    try {
      const proc = fakeFfmpeg();
      spawnMock.mockReturnValue(proc);
      await createPassthroughResource("/cache/v.m4a", item, { seekMs: 5000 });
      expect(proc.kill).not.toHaveBeenCalled();
      // No consumer ever attaches (no 'resume'); after the unconsumed-timeout window the
      // watchdog fires and reaps the orphan.
      vi.advanceTimersByTime(60_000);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog does NOT kill a child once its stdout is consumed (resume seen)", async () => {
    vi.useFakeTimers();
    try {
      const proc = fakeFfmpeg();
      spawnMock.mockReturnValue(proc);
      await createPassthroughResource("/cache/v.m4a", item, { seekMs: 5000 });
      // A real consumer attaching puts the stream in flowing mode → 'resume'.
      proc.stdout.emit("resume");
      vi.advanceTimersByTime(120_000);
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
