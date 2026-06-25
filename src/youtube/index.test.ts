import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("./ytdlp.js", () => ({ runYtDlp: runMock }));

import { YouTubeService } from "./index.js";
import { YtErrorKind } from "./errors.js";
import { loadMediaConfig } from "../config.js";

const cfg = loadMediaConfig({ MAX_TRACK_DURATION_SEC: "3600" });

function ok(stdout: string) {
  return { stdout, stderr: "", code: 0 };
}

describe("YouTubeService.resolve", () => {
  beforeEach(() => runMock.mockReset());

  it("maps yt-dlp -J output to TrackMeta", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          id: "dQw4w9WgXcQ",
          title: "Song",
          channel: "Chan",
          duration: 200,
          is_live: false,
          thumbnail: "http://t",
        }),
      ),
    );
    const svc = new YouTubeService(cfg);
    const meta = await svc.resolve("dQw4w9WgXcQ");
    expect(meta).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "Song",
      channel: "Chan",
      durationSec: 200,
      isLive: false,
      thumbnailUrl: "http://t",
    });
    // resolve uses -J --no-playlist on the canonical watch URL
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-J");
    expect(args).toContain("--no-playlist");
    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("falls back to uploader and Unknown channel, null duration", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "S", uploader: "Up" })),
    );
    const meta = await new YouTubeService(cfg).resolve("dQw4w9WgXcQ");
    expect(meta.channel).toBe("Up");
    expect(meta.durationSec).toBeNull();
  });

  it("throws Live for a live video", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "L", live_status: "is_live" })),
    );
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Live,
    });
  });

  it("throws Live for an upcoming video", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "U", live_status: "is_upcoming" })),
    );
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Live,
    });
  });

  it("throws TooLong over the duration cap", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "X", duration: 4000 })),
    );
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.TooLong,
    });
  });

  it("classifies a non-zero exit", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: Private video", code: 1 });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Private,
    });
  });
});

describe("YouTubeService.search", () => {
  beforeEach(() => runMock.mockReset());

  it("maps flat entries, tolerating missing channel/duration", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "aaaaaaaaaaa", title: "A", channel: "C", duration: 100 },
            { id: "bbbbbbbbbbb", title: "B" }, // missing channel + duration
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).search("q", 2);
    expect(res).toHaveLength(2);
    expect(res[1]).toEqual({
      videoId: "bbbbbbbbbbb",
      title: "B",
      channel: "Unknown",
      durationSec: null,
      isLive: false,
      thumbnailUrl: null,
    });
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args[args.length - 1]).toBe("ytsearch2:q");
    expect(args).toContain("--flat-playlist");
  });
});

describe("YouTubeService.download", () => {
  beforeEach(() => runMock.mockReset());

  it("returns the produced file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    const path = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("bestaudio[acodec=opus]/bestaudio/best");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--");
    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args).not.toContain("--sponsorblock-remove");
  });

  it("includes sponsorblock args when SPONSORBLOCK_REMOVE is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.opus"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    const sbCfg = loadMediaConfig({
      MAX_TRACK_DURATION_SEC: "3600",
      SPONSORBLOCK_REMOVE: "sponsor,music_offtopic",
    });
    const path = await new YouTubeService(sbCfg).download("dQw4w9WgXcQ", dir);
    expect(path).toBe(join(dir, "dQw4w9WgXcQ.opus"));
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-x");
    expect(args).toContain("--audio-format");
    expect(args).toContain("opus");
    expect(args).toContain("--sponsorblock-remove");
    const sbIdx = args.indexOf("--sponsorblock-remove");
    expect(args[sbIdx + 1]).toBe("sponsor,music_offtopic");
  });

  it("throws when yt-dlp succeeds but no file is produced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    runMock.mockResolvedValue(ok(""));
    await expect(new YouTubeService(cfg).download("dQw4w9WgXcQ", dir)).rejects.toThrow();
  });
});
