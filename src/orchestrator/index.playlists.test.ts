import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuildController } from "./index.js";
import { PlaylistStore } from "./playlists.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { Semaphore } from "../util/semaphore.js";
import type { AudioInfo, Requester, TrackMeta } from "../types/index.js";

const AUDIO: AudioInfo = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
const requester: Requester = {
  discordUserId: "1",
  displayName: "u",
  avatarUrl: "a",
  source: "web",
};
const meta = (id: string): TrackMeta => ({
  videoId: id,
  title: id.toUpperCase(),
  channel: "c",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
});

class FakeSession extends EventEmitter {
  play = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  skip = vi.fn(() => this.emit("trackEnd"));
  stop = vi.fn();
  startIdleTimer = vi.fn();
  cancelIdleTimer = vi.fn();
  setIdleTimeout = vi.fn();
  destroy = vi.fn();
  channelId = "C1";
}

async function makeCtrl(dir: string) {
  const session = new FakeSession();
  const cacheStore = new Map<string, string>();
  const audioStore = new Map<string, AudioInfo | null>();
  const playlists = new PlaylistStore(dir);
  await playlists.init();
  const deps = {
    youtube: {
      download: vi.fn(async (id: string) => ({ path: `/cache/${id}.webm`, audio: AUDIO })),
      related: vi.fn(async () => [] as TrackMeta[]),
      artistTracks: vi.fn(async () => [] as TrackMeta[]),
    },
    cache: {
      get: (id: string) => cacheStore.get(id) ?? null,
      getAudio: (id: string) => audioStore.get(id) ?? null,
      has: (id: string) => cacheStore.has(id),
      register: (id: string, p: string, audio: AudioInfo | null = null) => {
        cacheStore.set(id, p);
        audioStore.set(id, audio);
      },
      pin: vi.fn(),
      unpin: vi.fn(),
    },
    cacheDir: dir,
    createSession: vi.fn(async () => session as never),
    makeResource: vi.fn((p: string) => ({ res: p })),
    prefetchDepth: 1,
    idleTimeoutMs: 300_000,
    downloads: new Semaphore(2),
    settings: { ...DEFAULT_SETTINGS },
    playlists,
  };
  const ctrl = new GuildController("G1", deps as never);
  return { ctrl, session, playlists, deps };
}

describe("GuildController playlists", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ctrl-pl-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("savePlaylist captures current + upcoming metas in order", async () => {
    const { ctrl, playlists } = await makeCtrl(dir);
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0)); // first track promoted to current
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await ctrl.enqueue(meta("ccccccccccc"), requester);

    await ctrl.savePlaylist("set");
    const saved = playlists.get("G1", "set");
    expect(saved?.map((m) => m.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("savePlaylist with nothing queued throws (empty playlist)", async () => {
    const { ctrl } = await makeCtrl(dir);
    await ctrl.ensureConnected("C1");
    await expect(ctrl.savePlaylist("empty")).rejects.toThrow();
  });

  it("loadPlaylist enqueues every saved track for a requester", async () => {
    const { ctrl, playlists } = await makeCtrl(dir);
    await playlists.save("G1", "mix", [meta("aaaaaaaaaaa"), meta("bbbbbbbbbbb")]);
    await ctrl.ensureConnected("C1");
    const n = await ctrl.loadPlaylist("mix", requester);
    expect(n).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    const snap = ctrl.snapshot();
    const ids = [
      ...(snap.current ? [snap.current.meta.videoId] : []),
      ...snap.upcoming.map((i) => i.meta.videoId),
    ];
    expect(ids).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
  });

  it("loadPlaylist returns 0 (no enqueue) for an unknown name", async () => {
    const { ctrl } = await makeCtrl(dir);
    await ctrl.ensureConnected("C1");
    const n = await ctrl.loadPlaylist("nope", requester);
    expect(n).toBe(0);
    expect(ctrl.snapshot().current).toBeNull();
  });

  it("listPlaylists returns the store summaries", async () => {
    const { ctrl, playlists } = await makeCtrl(dir);
    await playlists.save("G1", "a", [meta("aaaaaaaaaaa")]);
    await playlists.save("G1", "b", [meta("bbbbbbbbbbb"), meta("ccccccccccc")]);
    const lists = ctrl.listPlaylists();
    expect(lists.map((p) => p.name).sort()).toEqual(["a", "b"]);
    expect(lists.find((p) => p.name === "b")?.trackCount).toBe(2);
  });

  it("deletePlaylist removes it and reports existence", async () => {
    const { ctrl, playlists } = await makeCtrl(dir);
    await playlists.save("G1", "gone", [meta("aaaaaaaaaaa")]);
    expect(await ctrl.deletePlaylist("missing")).toBe(false);
    expect(await ctrl.deletePlaylist("gone")).toBe(true);
    expect(ctrl.listPlaylists()).toEqual([]);
  });

  it("playlist methods are scoped to this controller's guildId", async () => {
    const { ctrl, playlists } = await makeCtrl(dir);
    // Saved under a different guild — invisible to this G1 controller.
    await playlists.save("G2", "other", [meta("aaaaaaaaaaa")]);
    expect(ctrl.listPlaylists()).toEqual([]);
    await ctrl.ensureConnected("C1");
    expect(await ctrl.loadPlaylist("other", requester)).toBe(0);
  });

  it("save/load round-trips persistently across controller instances", async () => {
    const a = await makeCtrl(dir);
    await a.ctrl.ensureConnected("C1");
    await a.ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await new Promise((r) => setTimeout(r, 0));
    await a.ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await a.ctrl.savePlaylist("persist me");

    // A fresh store over the same dir (simulating a restart) sees the playlist.
    const b = await makeCtrl(dir);
    expect(b.ctrl.listPlaylists().map((p) => p.name)).toEqual(["persist me"]);
    await b.ctrl.ensureConnected("C1");
    const n = await b.ctrl.loadPlaylist("persist me", requester);
    expect(n).toBe(2);
  });
});
