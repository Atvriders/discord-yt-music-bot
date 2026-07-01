import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMediaConfig, materializeCookies } from "./config.js";

describe("loadMediaConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadMediaConfig({});
    expect(c.cacheDir).toBe("/data/cache");
    expect(c.cacheMaxBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(c.searchResultCount).toBe(5);
    expect(c.playerClients).toBe("android_vr,web_embedded,tv");
    expect(c.maxTrackDurationSec).toBeNull();
    expect(c.sponsorblockRemove).toBeNull();
    // Pin the remaining defaults so an accidental change to any of them is caught.
    expect(c.historyMaxItems).toBe(100);
    expect(c.ytdlpTimeoutMs).toBe(60000);
    expect(c.ytProxy).toBeNull();
    expect(c.ytCookiesFile).toBeNull();
    expect(c.ytCookiesText).toBeNull();
    expect(c.poTokenProviderUrl).toBeNull();
    expect(c.normalizeLoudness).toBe(false);
  });

  it("reads YT_COOKIES (path) and YT_COOKIES_TEXT (inline content)", () => {
    const c = loadMediaConfig({ YT_COOKIES: "/data/cookies.txt", YT_COOKIES_TEXT: "raw\ncookies" });
    expect(c.ytCookiesFile).toBe("/data/cookies.txt");
    expect(c.ytCookiesText).toBe("raw\ncookies");
  });

  it("parses overrides from env", () => {
    const c = loadMediaConfig({
      CACHE_DIR: "/tmp/c",
      CACHE_MAX_MB: "100",
      SEARCH_RESULT_COUNT: "3",
      MAX_TRACK_DURATION_SEC: "600",
      SPONSORBLOCK_REMOVE: "sponsor,music_offtopic",
      YT_PROXY: "socks5://127.0.0.1:1080",
    });
    expect(c.cacheDir).toBe("/tmp/c");
    expect(c.cacheMaxBytes).toBe(100 * 1024 * 1024);
    expect(c.searchResultCount).toBe(3);
    expect(c.maxTrackDurationSec).toBe(600);
    expect(c.sponsorblockRemove).toBe("sponsor,music_offtopic");
    expect(c.ytProxy).toBe("socks5://127.0.0.1:1080");
  });

  it("throws on a non-numeric CACHE_MAX_MB", () => {
    expect(() => loadMediaConfig({ CACHE_MAX_MB: "abc" })).toThrow(/CACHE_MAX_MB/);
  });

  it("throws on a float CACHE_MAX_MB", () => {
    expect(() => loadMediaConfig({ CACHE_MAX_MB: "1.5" })).toThrow(/CACHE_MAX_MB/);
  });

  it("rejects CACHE_MAX_MB below the minimum (0 or negative)", () => {
    // 0/negative are plausible operator misconfigs (e.g. 0 meant as "no limit"); the
    // { min: 1 } guard must reject them rather than building a zero/negative cache cap.
    expect(() => loadMediaConfig({ CACHE_MAX_MB: "0" })).toThrow(/CACHE_MAX_MB/);
    expect(() => loadMediaConfig({ CACHE_MAX_MB: "-512" })).toThrow(/CACHE_MAX_MB/);
  });

  it("reads NORMALIZE_LOUDNESS as a boolean seed (default false)", () => {
    expect(loadMediaConfig({}).normalizeLoudness).toBe(false);
    expect(loadMediaConfig({ NORMALIZE_LOUDNESS: "true" }).normalizeLoudness).toBe(true);
    expect(loadMediaConfig({ NORMALIZE_LOUDNESS: "false" }).normalizeLoudness).toBe(false);
  });

  it("normalizes MAX_TRACK_DURATION_SEC=0 to null (no ceiling, not a 0s ceiling)", () => {
    // A literal 0 must mean "no limit", matching the null convention — otherwise the
    // youtube guard would reject every positive-duration track and break all playback.
    expect(loadMediaConfig({ MAX_TRACK_DURATION_SEC: "0" }).maxTrackDurationSec).toBeNull();
  });

  it("rejects a negative MAX_TRACK_DURATION_SEC", () => {
    expect(() => loadMediaConfig({ MAX_TRACK_DURATION_SEC: "-1" })).toThrow(
      /MAX_TRACK_DURATION_SEC/,
    );
  });
});

describe("materializeCookies", () => {
  const base = {
    cacheDir: "/data/cache",
    cacheMaxBytes: 1,
    historyMaxItems: 1,
    searchResultCount: 1,
    maxTrackDurationSec: null,
    normalizeLoudness: false,
    ytProxy: null,
    ytCookiesFile: null as string | null,
    ytCookiesText: null as string | null,
    poTokenProviderUrl: null,
    sponsorblockRemove: null,
    playerClients: "tv",
    ytdlpTimeoutMs: 1,
  };

  it("returns null when neither a path nor inline text is set", async () => {
    expect(await materializeCookies({ ...base })).toBeNull();
  });

  it("an explicit YT_COOKIES path wins over inline text (no file written)", async () => {
    const path = await materializeCookies({
      ...base,
      ytCookiesFile: "/data/cookies.txt",
      ytCookiesText: "ignored",
    });
    expect(path).toBe("/data/cookies.txt");
  });

  it("writes inline text to <cacheDir>/yt-cookies.txt and returns that path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-"));
    const text = ".youtube.com\tTRUE\t/\tTRUE\t1799999999\tSID\tabc";
    const path = await materializeCookies({ ...base, cacheDir: dir, ytCookiesText: text });
    expect(path).toBe(join(dir, "yt-cookies.txt"));
    const written = await readFile(path!, "utf8");
    // Prepends the Netscape header when the pasted text lacks it, and keeps the cookie line.
    expect(written.startsWith("# Netscape HTTP Cookie File\n")).toBe(true);
    expect(written).toContain("\tSID\tabc");
  });

  it("does not double-prepend the header when the text already has it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-"));
    const text = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\tx";
    const path = await materializeCookies({ ...base, cacheDir: dir, ytCookiesText: text });
    const written = await readFile(path!, "utf8");
    expect(written.match(/# Netscape HTTP Cookie File/g)).toHaveLength(1);
  });
});
