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
    // Pin correct guildId routing through the factory (caching the Map key alone wouldn't
    // catch an impl that always passed the first guildId).
    expect(factory).toHaveBeenCalledWith("G1");
    expect(factory).toHaveBeenCalledWith("G2");
    expect(factory.mock.calls).toEqual([["G1"], ["G2"]]);
  });

  it("exposes guildIds() and controllers() matching the created controllers", () => {
    const factory = vi.fn((guildId: string) => ({ guildId }) as never);
    const hub = new GuildHub(factory);
    const a = hub.get("G1");
    const b = hub.get("G2");
    expect(hub.guildIds().sort()).toEqual(["G1", "G2"]);
    expect([...hub.controllers()]).toEqual(expect.arrayContaining([a, b]));
    expect([...hub.controllers()]).toHaveLength(2);
  });
});
