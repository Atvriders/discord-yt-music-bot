import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("./ytdlp.js", () => ({ runYtDlp: runMock }));

import { YouTubeService, parseAudioInfo, buildClientLadder } from "./index.js";
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

  it("passes the bgutil PO-token base_url extractor-arg when configured", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "S", duration: 10 })));
    const potCfg = loadMediaConfig({
      MAX_TRACK_DURATION_SEC: "3600",
      PO_TOKEN_PROVIDER_URL: "http://bgutil-pot:4416",
    });
    await new YouTubeService(potCfg).resolve("dQw4w9WgXcQ");
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416");
  });

  it("omits the bgutil extractor-arg when PO_TOKEN_PROVIDER_URL is unset", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "S", duration: 10 })));
    await new YouTubeService(cfg).resolve("dQw4w9WgXcQ");
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args.some((a) => a.startsWith("youtubepot-bgutilhttp:"))).toBe(false);
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

  it("throws TooLong over the global config sanity ceiling", async () => {
    // The configured MAX_TRACK_DURATION_SEC (3600 here) is now only an ABSOLUTE
    // sanity ceiling in resolve; the per-guild limit is the user-facing authority,
    // enforced later at enqueue. A 4000s track still exceeds this 3600s ceiling.
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "X", duration: 4000 })),
    );
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.TooLong,
    });
  });

  it("does NOT reject on the global ceiling when it is unset (null) — any length resolves", async () => {
    // With MAX_TRACK_DURATION_SEC unset, resolve imposes no ceiling; the per-guild
    // setting decides at enqueue. A 3h track resolves cleanly here.
    const noCeilCfg = loadMediaConfig({});
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "Concert", duration: 10800 })),
    );
    const meta = await new YouTubeService(noCeilCfg).resolve("dQw4w9WgXcQ");
    expect(meta.durationSec).toBe(10800);
  });

  it("treats MAX_TRACK_DURATION_SEC=0 as no ceiling (does not throw TooLong)", async () => {
    // 0 normalizes to null at the config layer, so a long track must resolve, not be rejected.
    const zeroCfg = loadMediaConfig({ MAX_TRACK_DURATION_SEC: "0" });
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "Long", duration: 7200 })),
    );
    const meta = await new YouTubeService(zeroCfg).resolve("dQw4w9WgXcQ");
    expect(meta.durationSec).toBe(7200);
  });

  it("classifies a non-zero exit", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: Private video", code: 1 });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Private,
    });
  });

  it("rejects a non-video id (playlist/Mix/channel) with a clear reason, never spawning yt-dlp", async () => {
    // A search/picker entry that is a Mix or playlist carries an id like "RDdQw4w9WgXcQ"
    // (not an 11-char video id). resolve must reject it up-front rather than hand a bogus
    // URL to yt-dlp (which would fail with an opaque error).
    await expect(new YouTubeService(cfg).resolve("RDdQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Unavailable,
    });
    await expect(new YouTubeService(cfg).resolve("PLsomeplaylist")).rejects.toMatchObject({
      kind: YtErrorKind.Unavailable,
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("retries the next player client when the first throws a retryable error, then succeeds", async () => {
    // android_vr (first configured client) hits a PO-token/SABR extraction break; the
    // ladder must fall through to web_embedded and succeed.
    runMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "ERROR: Only images are available for download; use --list-formats",
        code: 1,
      })
      .mockResolvedValueOnce(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "Back in Black" })));
    const meta = await new YouTubeService(cfg).resolve("dQw4w9WgXcQ");
    expect(meta.title).toBe("Back in Black");
    expect(runMock).toHaveBeenCalledTimes(2);
    const firstArgs = runMock.mock.calls[0]![0] as string[];
    const secondArgs = runMock.mock.calls[1]![0] as string[];
    const clientOf = (args: string[]) => {
      const i = args.indexOf("--extractor-args");
      return args[i + 1];
    };
    // first client is the head of the configured ladder; second is a distinct fallback.
    expect(clientOf(firstArgs)).toBe("youtube:player_client=android_vr");
    expect(clientOf(secondArgs)).not.toBe(clientOf(firstArgs));
  });

  it("stops the ladder immediately on a terminal error (no client swap can help)", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: Private video", code: 1 });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Private,
    });
    // Private is terminal — must NOT burn through every fallback client.
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the LAST client's error when every client fails", async () => {
    runMock.mockResolvedValue({
      stdout: "",
      stderr: "ERROR: Sign in to confirm you're not a bot. Your IP is likely being blocked",
      code: 1,
    });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.IpBlocked,
    });
    // Tried the WHOLE de-duplicated ladder — pin the exact count so an early-abort
    // regression in withClientFallback / isRetryableAcrossClients fails the test.
    expect(runMock).toHaveBeenCalledTimes(buildClientLadder(cfg.playerClients).length);
  });

  it("classifies non-JSON stdout on a zero-exit as a YtError(Unknown), not a raw SyntaxError", async () => {
    // yt-dlp exits 0 but emits truncated/empty stdout — JSON.parse would throw a
    // SyntaxError. resolve must surface a typed YtError(Unknown) instead.
    runMock.mockResolvedValue(ok("not json at all"));
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Unknown,
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

  it("populates thumbnailUrl from the flat-playlist `thumbnails` array (no single `thumbnail`)", async () => {
    // --flat-playlist search entries expose a `thumbnails` array, NOT a single `thumbnail`.
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            {
              id: "aaaaaaaaaaa",
              title: "A",
              thumbnails: [
                { url: "http://small", height: 90, width: 120 },
                { url: "http://large", height: 404, width: 720 },
              ],
            },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).search("q", 1);
    // Prefers the highest-resolution thumbnail in the array.
    expect(res[0]!.thumbnailUrl).toBe("http://large");
  });

  it("prefers a single `thumbnail` field when present", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            {
              id: "aaaaaaaaaaa",
              title: "A",
              thumbnail: "http://single",
              thumbnails: [{ url: "http://arr" }],
            },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).search("q", 1);
    expect(res[0]!.thumbnailUrl).toBe("http://single");
  });

  it("throws a YtError(Unknown) on non-JSON stdout instead of a raw SyntaxError", async () => {
    // A non-JSON zero-exit stdout must become a typed domain error so callers can
    // message it, rather than letting a SyntaxError escape to the framework.
    runMock.mockResolvedValue(ok("<<<not json>>>"));
    await expect(new YouTubeService(cfg).search("q", 1)).rejects.toMatchObject({
      kind: YtErrorKind.Unknown,
    });
  });
});

describe("YouTubeService.related", () => {
  beforeEach(() => runMock.mockReset());

  it("fetches the RD<id> mix as a flat-playlist and maps entries, skipping the seed id", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "seedaaaaaaa", title: "Seed" }, // the seed itself — must be skipped
            { id: "bbbbbbbbbbb", title: "B", channel: "C", duration: 120 },
            { id: "ccccccccccc", title: "C" }, // missing channel/duration tolerated
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).related("seedaaaaaaa");
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
    expect(res[1]).toEqual({
      videoId: "ccccccccccc",
      title: "C",
      channel: "Unknown",
      durationSec: null,
      isLive: false,
      thumbnailUrl: null,
    });

    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("--flat-playlist");
    // Targets YouTube's Mix/radio list for the seed video.
    expect(args[args.length - 1]).toBe(
      "https://www.youtube.com/watch?v=seedaaaaaaa&list=RDseedaaaaaaa",
    );
  });

  it("de-duplicates repeated entries", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "bbbbbbbbbbb", title: "B" },
            { id: "bbbbbbbbbbb", title: "B again" },
            { id: "ccccccccccc", title: "C" },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).related("seedaaaaaaa");
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("returns [] on a non-zero exit instead of throwing (autoplay is best-effort)", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: nope", code: 1 });
    await expect(new YouTubeService(cfg).related("seedaaaaaaa")).resolves.toEqual([]);
  });

  it("returns [] when the mix has no entries", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({})));
    await expect(new YouTubeService(cfg).related("seedaaaaaaa")).resolves.toEqual([]);
  });

  it("returns [] (never throws) when the runner itself rejects", async () => {
    // A runner-level rejection (spawn ENOENT, timeout YtError) must honor the documented
    // best-effort contract and resolve to [], mirroring artistTracks().
    runMock.mockImplementationOnce(() => Promise.reject(new Error("spawn failed")));
    await expect(new YouTubeService(cfg).related("seedaaaaaaa")).resolves.toEqual([]);
  });
});

describe("YouTubeService.artistTracks", () => {
  beforeEach(() => runMock.mockReset());

  const seed = {
    videoId: "seedaaaaaaa",
    title: "Seed Song",
    channel: "Some Artist",
    durationSec: 200,
    isLive: false,
    thumbnailUrl: null,
  } as const;

  it("searches YouTube for more songs by the seed's channel and maps entries, skipping the seed id", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "seedaaaaaaa", title: "Seed Song" }, // the seed itself — must be skipped
            { id: "bbbbbbbbbbb", title: "B", channel: "Some Artist", duration: 120 },
            { id: "ccccccccccc", title: "C" },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).artistTracks(seed);
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);

    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("--flat-playlist");
    // The query is a ytsearchN: targeting the seed's channel/artist name.
    const query = args[args.length - 1] as string;
    expect(query).toMatch(/^ytsearch\d+:/);
    expect(query).toContain("Some Artist");
  });

  it("de-duplicates repeated entries", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "bbbbbbbbbbb", title: "B" },
            { id: "bbbbbbbbbbb", title: "B again" },
            { id: "ccccccccccc", title: "C" },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).artistTracks(seed);
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("returns [] (never throws) on a non-zero exit", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: nope", code: 1 });
    await expect(new YouTubeService(cfg).artistTracks(seed)).resolves.toEqual([]);
  });

  it("returns [] (never throws) when the runner itself rejects", async () => {
    runMock.mockImplementationOnce(() => Promise.reject(new Error("spawn failed")));
    await expect(new YouTubeService(cfg).artistTracks(seed)).resolves.toEqual([]);
  });

  it("returns [] when the search has no entries", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({})));
    await expect(new YouTubeService(cfg).artistTracks(seed)).resolves.toEqual([]);
  });

  it("returns [] without calling yt-dlp when the channel is missing/unknown", async () => {
    const res = await new YouTubeService(cfg).artistTracks({ ...seed, channel: "Unknown" });
    expect(res).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe("YouTubeService.download", () => {
  beforeEach(() => runMock.mockReset());

  it("returns the produced file path and parsed audio format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok("AUDIOFMT::opus|160|165|48000\n"));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(res.audio).toEqual({ codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 });
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("bestaudio[acodec=opus]/bestaudio/best");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--");
    // requests the real format via a post-download --print
    expect(args).toContain("--print");
    const printIdx = args.indexOf("--print");
    expect(args[printIdx + 1]).toContain("after_move:");
    expect(args[printIdx + 1]).toContain("%(acodec)s");
    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args).not.toContain("--sponsorblock-remove");
  });

  it("returns null audio when yt-dlp prints no usable format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(res.audio).toBeNull();
  });

  it("includes sponsorblock args when SPONSORBLOCK_REMOVE is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.opus"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    const sbCfg = loadMediaConfig({
      MAX_TRACK_DURATION_SEC: "3600",
      SPONSORBLOCK_REMOVE: "sponsor,music_offtopic",
    });
    const res = await new YouTubeService(sbCfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.opus"));
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

  it("falls back to the next player client when the first download fails, then succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "ERROR: nsig extraction failed: Some formats may be missing",
        code: 1,
      })
      .mockResolvedValueOnce(ok("AUDIOFMT::opus|160|165|48000\n"));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(res.audio).toEqual({ codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 });
    expect(runMock).toHaveBeenCalledTimes(2);
    const clientOf = (args: string[]) => args[args.indexOf("--extractor-args") + 1];
    const c1 = clientOf(runMock.mock.calls[0]![0] as string[]);
    const c2 = clientOf(runMock.mock.calls[1]![0] as string[]);
    expect(c1).toBe("youtube:player_client=android_vr");
    expect(c2).not.toBe(c1);
  });
});

describe("parseAudioInfo", () => {
  it("parses codec, abr (preferred bitrate), and asr", () => {
    expect(parseAudioInfo("AUDIOFMT::opus|160|200|48000")).toEqual({
      codec: "opus",
      bitrateKbps: 160,
      sampleRateHz: 48000,
    });
  });

  it("falls back to tbr when abr is NA", () => {
    expect(parseAudioInfo("AUDIOFMT::aac|NA|129.5|44100")).toEqual({
      codec: "aac",
      bitrateKbps: 130, // rounded tbr
      sampleRateHz: 44100,
    });
  });

  it("locates the marker line amid other stdout", () => {
    const out = "[download] 100%\nsome noise\nAUDIOFMT::mp4a.40.2|128|130|44100\n";
    expect(parseAudioInfo(out)).toEqual({
      codec: "mp4a.40.2",
      bitrateKbps: 128,
      sampleRateHz: 44100,
    });
  });

  it("returns null when codec is missing/NA", () => {
    expect(parseAudioInfo("AUDIOFMT::NA|NA|NA|NA")).toBeNull();
    expect(parseAudioInfo("AUDIOFMT::none|1|1|1")).toBeNull();
  });

  it("returns null when the marker is absent", () => {
    expect(parseAudioInfo("nothing here\n[download] done")).toBeNull();
  });

  it("zeroes numeric fields that are unparseable but keeps the codec", () => {
    expect(parseAudioInfo("AUDIOFMT::opus|NA|NA|NA")).toEqual({
      codec: "opus",
      bitrateKbps: 0,
      sampleRateHz: 0,
    });
  });
});
