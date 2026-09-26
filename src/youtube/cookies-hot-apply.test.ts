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

// yt-dlp silently DROPS any client that does not support cookies once it holds a real sign-in
// (android_vr is one — the bot's first rung), and keeps a separate default set for signed-in
// sessions. With a jar in play the ladder must lead with that default, or importing a VALID
// session makes the primary client vanish.
describe("signed-in client ladder", () => {
  function clientsTried(): (string | null)[] {
    return runMock.mock.calls.map((c) => {
      const args = c[0] as string[];
      const i = args.findIndex((a) => a.startsWith("youtube:player_client="));
      return i === -1 ? null : args[i]!.slice("youtube:player_client=".length);
    });
  }

  it("leads with yt-dlp's own client choice when a cookie jar is active", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    setCookiesFile("/data/cache/yt-cookies.txt");
    await yt.resolve("jNQXAC9IVRw");
    // First attempt forces NO player_client, so yt-dlp picks its authenticated defaults.
    expect(clientsTried()[0]).toBeNull();
  });

  it("keeps the configured ladder behind it as a fallback", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    setCookiesFile("/data/cache/yt-cookies.txt");
    runMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "ERROR: The page needs to be reloaded.",
        code: 1,
      })
      .mockResolvedValue(meta());
    await yt.resolve("jNQXAC9IVRw");
    expect(clientsTried().slice(0, 2)).toEqual([null, "android_vr"]);
  });

  it("does not change the anonymous ladder at all", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    await yt.resolve("jNQXAC9IVRw");
    expect(clientsTried()[0]).toBe("android_vr");
  });
});

// An extraction succeeding does not prove the cookies work: a public video extracts fine logged
// OUT, which is exactly what yt-dlp falls back to when YouTube rejects a rotated session — after
// a WARNING that playback's --no-warnings hides. Reproduced against yt-dlp 2026.08.19.
describe("probeSession tells a rejected session apart from a working one", () => {
  const ROTATED =
    "WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser as a security measure.\n";

  it("keeps yt-dlp's warnings, which playback suppresses", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    setCookiesFile("/data/cache/yt-cookies.txt");
    await yt.probeSession("jNQXAC9IVRw");
    expect(runMock.mock.calls[0]![0]).not.toContain("--no-warnings");
    await yt.resolve("jNQXAC9IVRw");
    expect(runMock.mock.calls.at(-1)![0]).toContain("--no-warnings");
  });

  it("reports a rejected session even though the extraction itself succeeded", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    setCookiesFile("/data/cache/yt-cookies.txt");
    runMock.mockResolvedValue({ ...meta(), stderr: ROTATED });
    expect(await yt.probeSession("jNQXAC9IVRw")).toEqual({ cookiesRejected: true });
  });

  it("reports a healthy session as healthy", async () => {
    const yt = new YouTubeService(loadMediaConfig({}));
    setCookiesFile("/data/cache/yt-cookies.txt");
    expect(await yt.probeSession("jNQXAC9IVRw")).toEqual({ cookiesRejected: false });
  });

  it("names the rejection, not the symptom, when every rung then fails", async () => {
    // What produced the live "unknown": the session was refused, and the last rung's error
    // ("The page needs to be reloaded") matched no rule.
    const yt = new YouTubeService(loadMediaConfig({}));
    setCookiesFile("/data/cache/yt-cookies.txt");
    runMock.mockResolvedValue({
      stdout: "",
      stderr: `${ROTATED}ERROR: [youtube] jNQXAC9IVRw: The page needs to be reloaded.\n`,
      code: 1,
    });
    await expect(yt.probeSession("jNQXAC9IVRw")).rejects.toMatchObject({
      kind: "cookies_rejected",
    });
    // Terminal: every rung sends the same jar, so the ladder stops instead of retrying seven times.
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
