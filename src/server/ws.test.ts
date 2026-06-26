import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { GuildBroadcaster, isAllowedOrigin } from "./ws.js";

describe("isAllowedOrigin", () => {
  it("matches the allowlist exactly", () => {
    const allow = ["https://m.example.com"];
    expect(isAllowedOrigin("https://m.example.com", allow)).toBe(true);
    expect(isAllowedOrigin("https://evil.com", allow)).toBe(false);
    expect(isAllowedOrigin(undefined, allow)).toBe(false);
  });
});

describe("GuildBroadcaster", () => {
  it("broadcasts only to subscribers of a guild", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn(),
      c = vi.fn();
    b.subscribe("G1", a);
    b.subscribe("G2", c);
    b.broadcast("G1", { type: "state", state: 1 });
    expect(a).toHaveBeenCalledWith({ type: "state", state: 1 });
    expect(c).not.toHaveBeenCalled();
  });
  it("stops sending after unsubscribe", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn();
    b.subscribe("G1", a);
    b.unsubscribe("G1", a);
    b.broadcast("G1", { type: "state", state: 1 });
    expect(a).not.toHaveBeenCalled();
  });
  it("attach wires controller.queue 'changed' to a state broadcast (once per guild)", () => {
    const b = new GuildBroadcaster();
    const queue = new EventEmitter();
    const controller = { queue, snapshot: () => ({ current: null, upcoming: [], history: [] }) };
    const sub = vi.fn();
    b.attach("G1", controller as never);
    b.attach("G1", controller as never); // second attach must NOT double-wire
    b.subscribe("G1", sub);
    queue.emit("changed");
    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }));
  });
});
