import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("./ytdlp.js", () => ({ runYtDlp: runMock }));

import { YouTubeService, setCookiesFile, resetCookiesFileForTests } from "./index.js";
import { loadMediaConfig } from "../config.js";

/**
 * The hot-apply hook is the difference between "paste new cookies" and "paste new cookies, then
 * edit docker-compose and redeploy". These tests pin the only thing that makes it real: the
 * `--cookies` argument yt-dlp is actually spawned with, read fresh on EVERY invocation.
 */

/** One well-formed metadata line, enough for resolve() to succeed. */
function meta(): { stdout: string; stderr: string; code: number } {
  return {
    stdout: JSON.stringify({
      id: "jNQXAC9IVRw",
      title: "Me at the zoo",
      uploader: "jawed",
      duration: 19,
      is_live: false,
    }),
    stderr: "",
    code: 0,
  };
}

/** The `--cookies <path>` pair from the most recent spawn, or null when it carried none. */
function lastCookiesArg(): string | null {
  const args = runMock.mock.calls.at(-1)?.[0] as string[] | undefined;
  if (!args) return null;
  const i = args.indexOf("--cookies");
  return i === -1 ? null : (args[i + 1] ?? null);
}

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue(meta());
  resetCookiesFileForTests();
});
afterEach(() => resetCookiesFileForTests());

describe("setCookiesFile — a saved jar takes effect without a restart", () => {
  it("uses the CONFIGURED jar until the console applies one", async () => {
    const yt = new YouTubeService(loadMediaConfig({ YT_COOKIES: "/data/cache/from-config.txt" }));
    await yt.resolve("jNQXAC9IVRw");
    expect(lastCookiesArg()).toBe("/data/cache/from-config.txt");
  });

  it("passes no --cookies at all when nothing is configured", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    await yt.resolve("jNQXAC9IVRw");
    expect(lastCookiesArg()).toBeNull();
  });

  it("switches the NEXT run to the applied jar, on a service built beforehand", async () => {
    // The service is constructed first, exactly as in main(): the console must be able to
    // redirect an extractor that already exists, not just a freshly built one.
    const yt = new YouTubeService(loadMediaConfig({ YT_COOKIES: "/data/cache/old.txt" }));
    await yt.resolve("jNQXAC9IVRw");
    expect(lastCookiesArg()).toBe("/data/cache/old.txt");

    setCookiesFile("/data/cache/yt-cookies.txt");
    await yt.resolve("jNQXAC9IVRw");
    expect(lastCookiesArg()).toBe("/data/cache/yt-cookies.txt");
  });

  it("applies to EVERY bot's extractor, because they share one module-level jar", async () => {
    // Multi-bot: one YouTubeService is shared today, but even two instances must agree — the
    // console is process-wide and there is only one jar on disk.
    const a = new YouTubeService(loadMediaConfig({}));
    const b = new YouTubeService(loadMediaConfig({ YT_COOKIES: "/data/cache/b.txt" }));
    setCookiesFile("/data/cache/shared.txt");
    await a.resolve("jNQXAC9IVRw");
    expect(lastCookiesArg()).toBe("/data/cache/shared.txt");
    await b.resolve("jNQXAC9IVRw");
    expect(lastCookiesArg()).toBe("/data/cache/shared.txt");
  });

  it("null means run WITHOUT cookies, and is distinct from 'never applied'", async () => {
    const yt = new YouTubeService(loadMediaConfig({ YT_COOKIES: "/data/cache/from-config.txt" }));
    setCookiesFile(null);
    await yt.resolve("jNQXAC9IVRw");
    // An explicit null OVERRIDES the configured path — it is not a no-op that falls back to it.
    expect(lastCookiesArg()).toBeNull();

    resetCookiesFileForTests();
    await yt.resolve("jNQXAC9IVRw");
    expect(lastCookiesArg()).toBe("/data/cache/from-config.txt");
  });

  it("reaches SEARCH too — the one call site that used to run signed-out", async () => {
    // A regression guard with teeth: search() and artistTracks() built their args by hand and
    // omitted netArgs entirely, so on a flagged IP the picker hit the bot check with no cookies
    // and no proxy while every other path was authenticated.
    const yt = new YouTubeService(loadMediaConfig({ YT_PROXY: "socks5://127.0.0.1:1080" }));
    setCookiesFile("/data/cache/yt-cookies.txt");
    runMock.mockResolvedValue({ stdout: JSON.stringify({ entries: [] }), stderr: "", code: 0 });

    await yt.search("some song name", 3);
    expect(lastCookiesArg()).toBe("/data/cache/yt-cookies.txt");
    expect(runMock.mock.calls.at(-1)?.[0]).toContain("--proxy");

    await yt.artistTracks({
      videoId: "jNQXAC9IVRw",
      title: "t",
      channel: "Some Artist",
      durationSec: 10,
      isLive: false,
      thumbnailUrl: null,
    });
    expect(lastCookiesArg()).toBe("/data/cache/yt-cookies.txt");
    expect(runMock.mock.calls.at(-1)?.[0]).toContain("--proxy");
  });

  it("also reaches the non-YouTube (SoundCloud) path, which shares netArgs", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    setCookiesFile("/data/cache/yt-cookies.txt");
    runMock.mockResolvedValue({
      stdout: JSON.stringify({
        id: "12345",
        title: "a track",
        uploader: "someone",
        duration: 60,
        is_live: false,
        webpage_url: "https://soundcloud.com/someone/a-track",
      }),
      stderr: "",
      code: 0,
    });
    await yt.resolveUrl("https://soundcloud.com/someone/a-track");
    expect(lastCookiesArg()).toBe("/data/cache/yt-cookies.txt");
  });
});
