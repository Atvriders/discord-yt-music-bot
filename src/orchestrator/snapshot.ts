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

/**
 * Snapshot filename for a bot. Bot "1" (and the legacy single-bot case, botId omitted) keeps the
 * original `session-snapshot.json` so an existing deployment's saved sessions still restore;
 * additional bots get a per-id file so their sessions never collide.
 */
function fileFor(botId?: string): string {
  return botId && botId !== "1" ? `session-snapshot.${botId}.json` : FILE;
}

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

export async function writeSnapshot(
  dir: string,
  file: SnapshotFile,
  botId?: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = fileFor(botId);
  const tmp = join(dir, `${name}.tmp`);
  await writeFile(tmp, JSON.stringify(file));
  await rename(tmp, join(dir, name)); // atomic swap
}

export async function readSnapshot(dir: string, botId?: string): Promise<SnapshotFile | null> {
  try {
    const raw = await readFile(join(dir, fileFor(botId)), "utf8");
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
    // readSnapshot only checks version + guilds-is-array; individual entries come straight
    // from disk and a partial/corrupt write could leave voiceChannelId or items malformed.
    // Skip such entries (rather than calling restore(undefined, …) → fetch(undefined)).
    if (
      typeof g.guildId !== "string" ||
      !g.guildId ||
      typeof g.voiceChannelId !== "string" ||
      !g.voiceChannelId ||
      !Array.isArray(g.items)
    ) {
      log.error({ guildId: g.guildId }, "skipping malformed snapshot entry");
      continue;
    }
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
