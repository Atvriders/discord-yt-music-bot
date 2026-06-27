import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioCache } from "./index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cache-"));
});

async function makeFile(name: string, bytes: number): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, Buffer.alloc(bytes));
  return p;
}

describe("AudioCache", () => {
  it("registers and retrieves a file, tracking total bytes", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    const p = await makeFile("aaaaaaaaaaa.webm", 300);
    cache.register("aaaaaaaaaaa", p);
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.get("aaaaaaaaaaa")).toBe(p);
    expect(cache.totalBytes()).toBe(300);
  });

  it("evicts the least-recently-used file when over the cap", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300)); // total 600 > 500
    // 'a' is LRU and should be evicted from disk + index.
    expect(cache.has("aaaaaaaaaaa")).toBe(false);
    expect(existsSync(join(dir, "aaaaaaaaaaa.webm"))).toBe(false);
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
  });

  it("get() refreshes recency so the other entry is evicted next", async () => {
    const cache = new AudioCache(dir, 650);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300));
    cache.get("aaaaaaaaaaa"); // touch 'a' → 'b' now LRU
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm", 300)); // 900 > 650
    expect(cache.has("bbbbbbbbbbb")).toBe(false);
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
  });

  it("never evicts a pinned entry, even if it is LRU", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.pin("aaaaaaaaaaa");
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300)); // 600 > 500
    expect(cache.has("aaaaaaaaaaa")).toBe(true); // pinned survives
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
    cache.unpin("aaaaaaaaaaa");
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm", 300));
    expect(cache.has("aaaaaaaaaaa")).toBe(false); // now evictable
  });

  it("get() returns null for an unknown id", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    expect(cache.get("zzzzzzzzzzz")).toBeNull();
  });

  it("stores and returns the audio format passed to register", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    const audio = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 100), audio);
    expect(cache.getAudio("aaaaaaaaaaa")).toEqual(audio);
    expect(cache.getAudio("unknownnnnn")).toBeNull();
  });

  it("getAudio defaults to null when no format was supplied", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 100));
    expect(cache.getAudio("aaaaaaaaaaa")).toBeNull();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
});
