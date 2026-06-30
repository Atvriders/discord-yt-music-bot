import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaylistStore, PLAYLISTS_FILE } from "./playlists.js";
import type { TrackMeta } from "../types/index.js";

const meta = (id: string): TrackMeta => ({
  videoId: id,
  title: id.toUpperCase(),
  channel: "c",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
});

describe("PlaylistStore", () => {
  it("saves a named playlist and lists it back (round-trip in memory)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      await store.save("G1", "chill", [meta("aaaaaaaaaaa"), meta("bbbbbbbbbbb")]);
      const lists = store.list("G1");
      expect(lists).toHaveLength(1);
      expect(lists[0]).toMatchObject({ name: "chill", trackCount: 2 });
      expect(store.get("G1", "chill")?.map((m) => m.videoId)).toEqual([
        "aaaaaaaaaaa",
        "bbbbbbbbbbb",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists to a JSON file under the dir and reloads it in a fresh store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      await store.save("G1", "road trip", [meta("aaaaaaaaaaa")]);

      // The file actually exists on disk with the expected shape.
      const raw = await readFile(join(dir, PLAYLISTS_FILE), "utf8");
      const parsed = JSON.parse(raw) as { version: number; guilds: Record<string, unknown> };
      expect(parsed.version).toBe(1);
      expect(parsed.guilds).toHaveProperty("G1");

      // A brand-new store over the same dir sees the persisted playlist.
      const reloaded = new PlaylistStore(dir);
      await reloaded.init();
      expect(reloaded.list("G1").map((p) => p.name)).toEqual(["road trip"]);
      expect(reloaded.get("G1", "road trip")?.map((m) => m.videoId)).toEqual(["aaaaaaaaaaa"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is per-guild: a playlist in one guild is invisible to another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      await store.save("G1", "mine", [meta("aaaaaaaaaaa")]);
      expect(store.list("G2")).toEqual([]);
      expect(store.get("G2", "mine")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overwrites a playlist saved under an existing name (no duplicate)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      await store.save("G1", "set", [meta("aaaaaaaaaaa")]);
      await store.save("G1", "set", [meta("bbbbbbbbbbb"), meta("ccccccccccc")]);
      expect(store.list("G1")).toHaveLength(1);
      expect(store.get("G1", "set")?.map((m) => m.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes a named playlist and returns whether it existed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      await store.save("G1", "a", [meta("aaaaaaaaaaa")]);
      expect(await store.delete("G1", "missing")).toBe(false);
      expect(await store.delete("G1", "a")).toBe(true);
      expect(store.list("G1")).toEqual([]);

      // The deletion is persisted: a fresh store does not see it.
      const reloaded = new PlaylistStore(dir);
      await reloaded.init();
      expect(reloaded.list("G1")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a blank name and trims surrounding whitespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      await expect(store.save("G1", "   ", [meta("aaaaaaaaaaa")])).rejects.toThrow();
      await store.save("G1", "  spaced  ", [meta("aaaaaaaaaaa")]);
      expect(store.list("G1").map((p) => p.name)).toEqual(["spaced"]);
      expect(store.get("G1", "spaced")).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("get()/delete() find a playlist saved under an over-80-char name (key clamp matches save)", async () => {
    // save() stores under the name clamped to MAX_NAME_LEN (80); get()/delete() previously used
    // only .trim() with no clamp, so a >80-char name was stored under its truncated key but
    // looked up under the full string — an unconditional miss (unreachable, undeletable).
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      const longName = "x".repeat(81); // exceeds MAX_NAME_LEN (80)
      await store.save("G1", longName, [meta("aaaaaaaaaaa")]);
      // Looking up with the SAME raw 81-char string must succeed (both sides clamp identically).
      expect(store.get("G1", longName)?.map((m) => m.videoId)).toEqual(["aaaaaaaaaaa"]);
      expect(await store.delete("G1", longName)).toBe(true);
      expect(store.list("G1")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects saving an empty track list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init();
      await expect(store.save("G1", "empty", [])).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("init on a missing/corrupt file starts empty rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      const store = new PlaylistStore(dir);
      await store.init(); // no file yet
      expect(store.list("G1")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list returns a savedAt timestamp newest-first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pl-"));
    try {
      let t = 1000;
      const store = new PlaylistStore(dir, () => (t += 1000));
      await store.init();
      await store.save("G1", "first", [meta("aaaaaaaaaaa")]);
      await store.save("G1", "second", [meta("bbbbbbbbbbb")]);
      const names = store.list("G1").map((p) => p.name);
      expect(names).toEqual(["second", "first"]);
      expect(store.list("G1")[0]!.savedAt).toBeGreaterThan(store.list("G1")[1]!.savedAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
