import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { QueueItem } from "../types/index.js";
import type { GuildSettings } from "./settings.js";

export interface GuildSnap {
  guildId: string;
  voiceChannelId: string;
  items: QueueItem[];
  /** Per-guild settings, persisted so they survive a restart (optional for back-compat). */
  settings?: GuildSettings;
}
export interface SnapshotFile {
  version: 1;
  savedAt: number;
  guilds: GuildSnap[];
}

interface ControllerLike {
  connectedChannelId: string | null;
  snapshot(): { current: QueueItem | null; upcoming: QueueItem[] };
  restore(channelId: string, items: QueueItem[]): Promise<void>;
  readonly settings?: GuildSettings;
  updateSettings?(patch: Partial<Record<keyof GuildSettings, unknown>>): GuildSettings;
}
interface HubLike {
  guildIds(): string[];
  get(guildId: string): ControllerLike;
}

const FILE = "session-snapshot.json";

export function collectSnapshot(hub: HubLike, now: number): SnapshotFile {
  const guilds: GuildSnap[] = [];
  for (const guildId of hub.guildIds()) {
    const c = hub.get(guildId);
    const channelId = c.connectedChannelId;
    if (!channelId) continue;
    const snap = c.snapshot();
    const items = [...(snap.current ? [snap.current] : []), ...snap.upcoming];
    if (items.length === 0) continue;
    guilds.push({ guildId, voiceChannelId: channelId, items, settings: c.settings });
  }
  return { version: 1, savedAt: now, guilds };
}

export async function writeSnapshot(dir: string, file: SnapshotFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(file));
  await rename(tmp, join(dir, FILE)); // atomic swap
}

export async function readSnapshot(dir: string): Promise<SnapshotFile | null> {
  try {
    const raw = await readFile(join(dir, FILE), "utf8");
    const parsed = JSON.parse(raw) as SnapshotFile;
    return parsed.version === 1 && Array.isArray(parsed.guilds) ? parsed : null;
  } catch {
    return null;
  }
}

export async function restoreSnapshot(
  file: SnapshotFile,
  hub: { get(g: string): ControllerLike },
  log: Pick<Logger, "info" | "error">,
): Promise<void> {
  for (const g of file.guilds) {
    try {
      const controller = hub.get(g.guildId);
      if (g.settings) controller.updateSettings?.(g.settings);
      await controller.restore(g.voiceChannelId, g.items);
      log.info({ guildId: g.guildId, tracks: g.items.length }, "restored session");
    } catch (err) {
      log.error({ guildId: g.guildId, err }, "failed to restore session");
    }
  }
}
