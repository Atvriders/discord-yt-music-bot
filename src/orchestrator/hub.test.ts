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

  it("has() reports existence without creating a controller", () => {
    // src/index.ts uses hub.has(guildId) as a guard specifically to AVOID auto-creating a
    // controller (which hub.get() does). Pin that no-side-effect contract so a refactor that
    // makes has() delegate to get() (or swaps the two) fails the suite.
    const factory = vi.fn((guildId: string) => ({ guildId }) as never);
    const hub = new GuildHub(factory);
    // has() before any get() must be false AND must not invoke the factory.
    expect(hub.has("G1")).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    // get() creates it.
    hub.get("G1");
    expect(factory).toHaveBeenCalledTimes(1);
    // has() now true, and calling it again does not re-invoke the factory.
    expect(hub.has("G1")).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
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
