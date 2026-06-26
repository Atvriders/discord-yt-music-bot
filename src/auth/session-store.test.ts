import { describe, it, expect } from "vitest";
import { MemorySessionStore } from "./session-store.js";

function p<T>(fn: (cb: (e: unknown, r?: T) => void) => void): Promise<T | undefined> {
  return new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r))));
}

describe("MemorySessionStore", () => {
  it("round-trips set → get and destroy removes", async () => {
    const s = new MemorySessionStore();
    await p((cb) => s.set("sid1", { userId: "u1" } as never, cb));
    const got = await p<{ userId: string }>((cb) => s.get("sid1", cb as never));
    expect(got).toEqual({ userId: "u1" });
    await p((cb) => s.destroy("sid1", cb));
    const after = await p((cb) => s.get("sid1", cb as never));
    expect(after ?? null).toBeNull();
  });
});
