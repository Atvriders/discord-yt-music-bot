import { describe, it, expect } from "vitest";
import { loadBotConfig } from "./config.js";

describe("loadBotConfig", () => {
  it("requires DISCORD_TOKEN", () => {
    expect(() => loadBotConfig({})).toThrow(/DISCORD_TOKEN/);
  });
  it("applies defaults", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t" });
    expect(c.commandPrefix).toBe("?");
    expect(c.idleTimeoutMs).toBe(300_000);
    expect(c.prefetchDepth).toBe(1);
    expect(c.maxConcurrentDownloads).toBe(2);
    expect(c.adminUserIds).toEqual([]);
  });
  it("parses admin ids (strict snowflakes, junk dropped)", () => {
    const c = loadBotConfig({
      DISCORD_TOKEN: "t",
      ADMIN_USER_IDS: "123456789012345678, 999, 234567890123456789",
    });
    expect(c.adminUserIds).toEqual(["123456789012345678", "234567890123456789"]);
  });
  it("defaults logLevel to info and accepts override", () => {
    const c1 = loadBotConfig({ DISCORD_TOKEN: "t" });
    expect(c1.logLevel).toBe("info");
    const c2 = loadBotConfig({ DISCORD_TOKEN: "t", LOG_LEVEL: "warn" });
    expect(c2.logLevel).toBe("warn");
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
