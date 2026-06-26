import { describe, it, expect, vi } from "vitest";
import { startupCanary } from "./canary.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("startupCanary", () => {
  it("returns true when a known video resolves", async () => {
    const youtube = { resolve: vi.fn(async () => ({ title: "ok" })) };
    expect(await startupCanary(youtube as never, log)).toBe(true);
    expect(youtube.resolve).toHaveBeenCalled();
  });
  it("returns false and logs when resolution fails", async () => {
    const youtube = {
      resolve: vi.fn(async () => {
        throw new Error("blocked");
      }),
    };
    expect(await startupCanary(youtube as never, log)).toBe(false);
  });
});
