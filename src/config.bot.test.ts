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
});
