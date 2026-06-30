import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { collectSnapshot, writeSnapshot, readSnapshot, restoreSnapshot } from "./snapshot.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const meta = (id: string) => ({
  videoId: id,
  title: id,
  channel: "c",
  durationSec: 1,
  isLive: false,
  thumbnailUrl: null,
});
const requester = {
  discordUserId: "1",
  displayName: "u",
  avatarUrl: "a",
  source: "discord" as const,
};
const item = (id: string) => ({
  id: `i-${id}`,
  meta: meta(id),
  requester,
  addedAt: 0,
  audio: null,
});

function fakeController(channelId: string | null, current: unknown, upcoming: unknown[]) {
  return {
    connectedChannelId: channelId,
    snapshot: () => ({ current, upcoming, history: [] }),
    restore: vi.fn(async () => {}),
  };
}

describe("snapshot", () => {
  it("collects connected guilds with current+upcoming, skips disconnected and empty-queue", () => {
    const hub = {
      guildIds: () => ["G1", "G2", "G3"],
      get: (g: string) =>
        g === "G1"
          ? fakeController("C1", item("aaaaaaaaaaa"), [item("bbbbbbbbbbb")])
          : g === "G2"
            ? fakeController(null, null, []) // disconnected → skipped (no channelId)
            : fakeController("C3", null, []), // connected but empty queue → skipped (no items)
    };
    const file = collectSnapshot(hub as never, 123);
    expect(file.guilds).toHaveLength(1);
    expect(file.guilds[0]).toMatchObject({ guildId: "G1", voiceChannelId: "C1" });
    expect(file.guilds[0]!.items.map((i) => i.meta.videoId)).toEqual([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
    ]);
    // C3 is connected yet skipped because its queue is empty (pins the items.length===0 guard).
    expect(file.guilds.some((g) => g.voiceChannelId === "C3")).toBe(false);
  });

  it("persists and restores per-guild settings", async () => {
    // Build from DEFAULT_SETTINGS so all 9 fields are covered (and future fields auto-track),
    // not just the original 4 — otherwise a dropped field (e.g. commandChannelId) on restart
    // would go undetected by the toEqual assertions below.
    const settings = {
      ...DEFAULT_SETTINGS,
      idleTimeoutSec: 120,
      crossfadeSec: 4,
      normalizeLoudness: true,
      repeat: "all" as const,
      volume: 80,
      fx: "bassboost" as const,
      maxTrackDurationSec: 600,
      commandChannelId: "CHAN1",
    };
    const collectHub = {
      guildIds: () => ["G1"],
      get: () => ({
        connectedChannelId: "C1",
        snapshot: () => ({ current: item("aaaaaaaaaaa"), upcoming: [] }),
        restore: vi.fn(async () => {}),
        settings,
      }),
    };
    const file = collectSnapshot(collectHub as never, 1);
    expect(file.guilds[0]!.settings).toEqual(settings);

    const updateSettings = vi.fn();
    const c = {
      connectedChannelId: "C1",
      snapshot: () => ({ current: null, upcoming: [] }),
      restore: vi.fn(async () => {}),
      updateSettings,
    };
    await restoreSnapshot(
      file as never,
      { get: () => c } as never,
      {
        info: vi.fn(),
        error: vi.fn(),
      } as never,
    );
    expect(updateSettings).toHaveBeenCalledWith(settings);
  });

  it("round-trips through disk and ignores a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-"));
    try {
      expect(await readSnapshot(dir)).toBeNull();
      const file = {
        version: 1 as const,
        savedAt: 1,
        guilds: [{ guildId: "G1", voiceChannelId: "C1", items: [item("aaaaaaaaaaa")] }],
      };
      await writeSnapshot(dir, file);
      expect(await readSnapshot(dir)).toEqual(file);

      // readSnapshot's guard returns null for an unrecognized version or a non-array guilds —
      // both plausible from a schema migration or a partial write. Pin both branches so an
      // accidental inversion/removal during a future schema bump is caught.
      const snapFile = join(dir, "session-snapshot.json");
      await writeFile(snapFile, JSON.stringify({ version: 2, savedAt: 1, guilds: [] }));
      expect(await readSnapshot(dir)).toBeNull();
      await writeFile(snapFile, JSON.stringify({ version: 1, savedAt: 1, guilds: null }));
      expect(await readSnapshot(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores each guild via controller.restore", async () => {
    const c = fakeController("C1", null, []);
    const hub = { get: () => c };
    await restoreSnapshot(
      {
        version: 1,
        savedAt: 1,
        guilds: [{ guildId: "G1", voiceChannelId: "C1", items: [item("aaaaaaaaaaa")] }],
      } as never,
      hub as never,
      { info: vi.fn(), error: vi.fn() } as never,
    );
    expect(c.restore).toHaveBeenCalledWith(
      "C1",
      expect.arrayContaining([expect.objectContaining({ id: "i-aaaaaaaaaaa" })]),
    );
  });

  it("skips malformed snapshot entries instead of calling restore with a bad channelId", async () => {
    const c = fakeController("C1", null, []);
    const hub = { get: () => c };
    const error = vi.fn();
    await restoreSnapshot(
      {
        version: 1,
        savedAt: 1,
        guilds: [
          { guildId: "G1", voiceChannelId: null, items: [item("aaaaaaaaaaa")] },
          { guildId: "G2", voiceChannelId: "C2", items: "nope" },
          { guildId: "G3", voiceChannelId: "C3", items: [item("bbbbbbbbbbb")] },
        ],
      } as never,
      hub as never,
      { info: vi.fn(), error } as never,
    );
    // Only the well-formed G3 entry should reach restore; the two malformed ones are skipped.
    expect(c.restore).toHaveBeenCalledTimes(1);
    expect(c.restore).toHaveBeenCalledWith("C3", expect.any(Array));
    expect(error).toHaveBeenCalledTimes(2);
  });
});
