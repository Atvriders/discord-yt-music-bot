import { describe, it, expect, vi } from "vitest";
import { GuildHub } from "./hub.js";

describe("GuildHub", () => {
  it("creates one controller per guild and reuses it", () => {
    const factory = vi.fn((guildId: string) => ({ guildId }) as never);
    const hub = new GuildHub(factory);
    const a1 = hub.get("G1");
    const a2 = hub.get("G1");
    const b = hub.get("G2");
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
