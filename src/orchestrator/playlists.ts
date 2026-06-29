import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrackMeta } from "../types/index.js";

/**
 * Persisted, per-guild named playlists. Each playlist is just an ordered list of track
 * metas (the same shape the queue stores), so loading one re-enqueues those tracks.
 *
 * Modeled on snapshot.ts: a single JSON file under media.cacheDir, written atomically
 * via a tmp-file + rename swap, and tolerant of a missing/corrupt file on load (starts
 * empty rather than throwing). The whole store is held in memory after init() so the
 * synchronous read paths (list/get) never touch disk; only save/delete persist.
 */

export interface SavedPlaylist {
  name: string;
  savedAt: number;
  tracks: TrackMeta[];
}

/** Summary returned to the panel/REST: the name + how many tracks + when it was saved. */
export interface PlaylistSummary {
  name: string;
  trackCount: number;
  savedAt: number;
}

interface PlaylistsFile {
  version: 1;
  // guildId -> (playlist name -> playlist). An object (not a Map) so it serializes cleanly.
  guilds: Record<string, Record<string, SavedPlaylist>>;
}

export const PLAYLISTS_FILE = "playlists.json";

/** Maximum length of a playlist name, to keep the panel/file sane. */
const MAX_NAME_LEN = 80;

export class PlaylistStore {
  private file: PlaylistsFile = { version: 1, guilds: {} };
  private readonly now: () => number;

  constructor(
    private readonly dir: string,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
  }

  /** Load the persisted playlists from disk. A missing/corrupt file starts empty. */
  async init(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, PLAYLISTS_FILE), "utf8");
      const parsed = JSON.parse(raw) as PlaylistsFile;
      if (parsed.version === 1 && parsed.guilds && typeof parsed.guilds === "object") {
        this.file = { version: 1, guilds: parsed.guilds };
      }
    } catch {
      // Missing or corrupt → keep the empty default.
    }
  }

  /** Normalize a name: trim, reject blank, clamp length. Throws on a blank name. */
  private normalizeName(name: string): string {
    const trimmed = (name ?? "").toString().trim();
    if (!trimmed) throw new Error("playlist name is required");
    return trimmed.slice(0, MAX_NAME_LEN);
  }

  /** Summaries of all playlists for a guild, newest-saved first. */
  list(guildId: string): PlaylistSummary[] {
    const byName = this.file.guilds[guildId];
    if (!byName) return [];
    return Object.values(byName)
      .map((p) => ({ name: p.name, trackCount: p.tracks.length, savedAt: p.savedAt }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /** The ordered track metas of a named playlist, or null if it doesn't exist. */
  get(guildId: string, name: string): TrackMeta[] | null {
    const key = (name ?? "").toString().trim();
    const pl = this.file.guilds[guildId]?.[key];
    return pl ? pl.tracks.map((t) => ({ ...t })) : null;
  }

  /**
   * Save (creating or overwriting) a named playlist for a guild, then persist to disk.
   * Throws on a blank name or an empty track list.
   */
  async save(guildId: string, name: string, tracks: TrackMeta[]): Promise<void> {
    const key = this.normalizeName(name);
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new Error("cannot save an empty playlist");
    }
    const byName = (this.file.guilds[guildId] ??= {});
    byName[key] = { name: key, savedAt: this.now(), tracks: tracks.map((t) => ({ ...t })) };
    await this.persist();
  }

  /** Delete a named playlist; returns whether it existed. Persists on a real deletion. */
  async delete(guildId: string, name: string): Promise<boolean> {
    const key = (name ?? "").toString().trim();
    const byName = this.file.guilds[guildId];
    if (!byName || !(key in byName)) return false;
    delete byName[key];
    if (Object.keys(byName).length === 0) delete this.file.guilds[guildId];
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${PLAYLISTS_FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(this.file));
    await rename(tmp, join(this.dir, PLAYLISTS_FILE)); // atomic swap
  }
}
