import { describe, it, expect } from "vitest";
import { loadBotConfig } from "./config.js";

describe("loadBotConfig", () => {
  it("requires DISCORD_TOKEN", () => {
    expect(() => loadBotConfig({})).toThrow(/DISCORD_TOKEN/);
  });
  it("applies defaults", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t" });
    expect(c.idleTimeoutMs).toBe(300_000);
    expect(c.prefetchDepth).toBe(1);
    expect(c.maxConcurrentDownloads).toBe(2);
    expect(c.adminUserIds).toEqual([]);
  });
  it('single-bot backward-compat: only DISCORD_TOKEN yields one bot (id "1", prefix "?")', () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t" });
    expect(c.bots).toHaveLength(1);
    expect(c.bots[0]).toEqual({
      id: "1",
      token: "t",
      commandPrefix: "?",
      name: "YouTube Music Bot",
    });
  });
  it("honors COMMAND_PREFIX / BOT_NAME overrides for bot 1", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t", COMMAND_PREFIX: "!", BOT_NAME: "DJ" });
    expect(c.bots[0]).toEqual({ id: "1", token: "t", commandPrefix: "!", name: "DJ" });
  });
  it("parses two bots via numbered envs with a non-overlapping default prefix + name", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t1", DISCORD_TOKEN_2: "t2" });
    expect(c.bots).toHaveLength(2);
    expect(c.bots[1]).toEqual({
      id: "2",
      token: "t2",
      commandPrefix: "!",
      name: "YouTube Music Bot 2",
    });
  });
  it("parses three bots with distinct non-overlapping default prefixes", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t1", DISCORD_TOKEN_2: "t2", DISCORD_TOKEN_3: "t3" });
    expect(c.bots.map((b) => b.id)).toEqual(["1", "2", "3"]);
    expect(c.bots.map((b) => b.commandPrefix)).toEqual(["?", "!", "$"]);
    expect(c.bots.map((b) => b.name)).toEqual([
      "YouTube Music Bot",
      "YouTube Music Bot 2",
      "YouTube Music Bot 3",
    ]);
  });
  it("honors COMMAND_PREFIX_<i> / BOT_NAME_<i> overrides for numbered bots", () => {
    const c = loadBotConfig({
      DISCORD_TOKEN: "t1",
      DISCORD_TOKEN_2: "t2",
      COMMAND_PREFIX_2: "!!",
      BOT_NAME_2: "Second",
    });
    expect(c.bots[1]).toEqual({ id: "2", token: "t2", commandPrefix: "!!", name: "Second" });
  });
  it("stops at the first gap (contiguous-only): DISCORD_TOKEN_3 without _2 gives only bot 1", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t1", DISCORD_TOKEN_3: "t3" });
    expect(c.bots.map((b) => b.id)).toEqual(["1"]);
  });
  it("treats an empty DISCORD_TOKEN_<i> as a gap that ends the list", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t1", DISCORD_TOKEN_2: "", DISCORD_TOKEN_3: "t3" });
    expect(c.bots.map((b) => b.id)).toEqual(["1"]);
  });
  it("throws when a command prefix is a prefix of another (overlap, incl. exact dupes)", () => {
    // Exact duplicate.
    expect(() =>
      loadBotConfig({ DISCORD_TOKEN: "t1", DISCORD_TOKEN_2: "t2", COMMAND_PREFIX_2: "?" }),
    ).toThrow(/overlap/i);
    // "?" is a prefix of "?2" — "?2play" also starts with "?", so it must be rejected too.
    expect(() =>
      loadBotConfig({ DISCORD_TOKEN: "t1", DISCORD_TOKEN_2: "t2", COMMAND_PREFIX_2: "?2" }),
    ).toThrow(/overlap/i);
  });
  it("parses admin ids (strict snowflakes, junk dropped)", () => {
    const c = loadBotConfig({
      DISCORD_TOKEN: "t",
      ADMIN_USER_IDS: "123456789012345678, 999, 234567890123456789",
    });
    expect(c.adminUserIds).toEqual(["123456789012345678", "234567890123456789"]);
  });
  it("defaults logLevel to info and accepts a valid override", () => {
    const c1 = loadBotConfig({ DISCORD_TOKEN: "t" });
    expect(c1.logLevel).toBe("info");
    const c2 = loadBotConfig({ DISCORD_TOKEN: "t", LOG_LEVEL: "warn" });
    expect(c2.logLevel).toBe("warn");
  });
  it("accepts a valid LOG_LEVEL in any case and normalizes to lowercase", () => {
    // A docker-compose/CI override like LOG_LEVEL=WARN must map to "warn", not silently
    // fall back to "info".
    expect(loadBotConfig({ DISCORD_TOKEN: "t", LOG_LEVEL: "WARN" }).logLevel).toBe("warn");
    expect(loadBotConfig({ DISCORD_TOKEN: "t", LOG_LEVEL: "Debug" }).logLevel).toBe("debug");
  });
  it("throws fast on an unrecognized LOG_LEVEL instead of silently demoting to info", () => {
    expect(() => loadBotConfig({ DISCORD_TOKEN: "t", LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
    expect(() => loadBotConfig({ DISCORD_TOKEN: "t", LOG_LEVEL: "nonsense" })).toThrow(/LOG_LEVEL/);
  });
  it("throws on non-integer IDLE_TIMEOUT_SEC", () => {
    expect(() => loadBotConfig({ DISCORD_TOKEN: "t", IDLE_TIMEOUT_SEC: "abc" })).toThrow(
      /IDLE_TIMEOUT_SEC/,
    );
  });
  it("throws on a float PREFETCH_DEPTH", () => {
    expect(() => loadBotConfig({ DISCORD_TOKEN: "t", PREFETCH_DEPTH: "1.5" })).toThrow(
      /PREFETCH_DEPTH/,
    );
  });
  it("throws on non-integer MAX_TRANSCODE_JOBS", () => {
    expect(() => loadBotConfig({ DISCORD_TOKEN: "t", MAX_TRANSCODE_JOBS: "x" })).toThrow(
      /MAX_TRANSCODE_JOBS/,
    );
  });
  it("throws on MAX_TRANSCODE_JOBS=0 (would deadlock the download Semaphore)", () => {
    expect(() => loadBotConfig({ DISCORD_TOKEN: "t", MAX_TRANSCODE_JOBS: "0" })).toThrow(
      /MAX_TRANSCODE_JOBS/,
    );
  });
  it("accepts PREFETCH_DEPTH=0 (disables prefetch)", () => {
    expect(loadBotConfig({ DISCORD_TOKEN: "t", PREFETCH_DEPTH: "0" }).prefetchDepth).toBe(0);
  });
});
