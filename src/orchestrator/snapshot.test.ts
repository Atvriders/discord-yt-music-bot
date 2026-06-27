import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot, writeSnapshot, readSnapshot, restoreSnapshot } from "./snapshot.js";

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
  it("collects connected guilds with current+upcoming, skips disconnected", () => {
    const hub = {
      guildIds: () => ["G1", "G2"],
      get: (g: string) =>
        g === "G1"
          ? fakeController("C1", item("aaaaaaaaaaa"), [item("bbbbbbbbbbb")])
          : fakeController(null, null, []),
    };
    const file = collectSnapshot(hub as never, 123);
    expect(file.guilds).toHaveLength(1);
    expect(file.guilds[0]).toMatchObject({ guildId: "G1", voiceChannelId: "C1" });
    expect(file.guilds[0]!.items.map((i) => i.meta.videoId)).toEqual([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
    ]);
  });

  it("persists and restores per-guild settings", async () => {
    const settings = {
      idleTimeoutSec: 120,
      crossfadeSec: 4,
      normalizeLoudness: true,
      repeat: "all" as const,
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
});
