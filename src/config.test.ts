import { describe, it, expect } from "vitest";
import { loadMediaConfig } from "./config.js";

describe("loadMediaConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadMediaConfig({});
    expect(c.cacheDir).toBe("/data/cache");
    expect(c.cacheMaxBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(c.searchResultCount).toBe(5);
    expect(c.playerClients).toBe("android_vr,web_embedded,tv");
    expect(c.maxTrackDurationSec).toBeNull();
    expect(c.sponsorblockRemove).toBeNull();
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
