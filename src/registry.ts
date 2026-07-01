import type { Client } from "discord.js";
import type { GuildHub } from "./orchestrator/hub.js";
import type { NowPlayingManager } from "./discord/np-message.js";
import type { PresenceController } from "./discord/presence.js";

/**
 * One running Discord bot: its own gateway Client, its own per-guild controller hub, its own
 * command prefix, live now-playing message manager, and presence. Multiple BotRuntimes run in
 * one process (a list of tokens) so each can play a DIFFERENT song in a different voice channel.
 * They share the process-wide YouTubeService / AudioCache / downloads Semaphore / PlaylistStore /
 * WS broadcaster (wired in index.ts).
 */
export interface BotRuntime {
  /** Stable id ("1", "2", …) — the 1-based index of the bot in config order. */
  id: string;
  /** Display name shown in the panel's bot-picker. */
  name: string;
  /** This bot's `?`-style command prefix (distinct across bots). */
  prefix: string;
  client: Client;
  hub: GuildHub;
  nowPlaying: NowPlayingManager;
  presence: PresenceController;
}

/** Immutable lookup over the process's bots, by id and in config order. */
export class BotRegistry {
  private readonly byId: Map<string, BotRuntime>;
  constructor(private readonly bots: BotRuntime[]) {
    this.byId = new Map(bots.map((b) => [b.id, b]));
  }
  /** All bots, in config order (bot "1" first). */
  list(): BotRuntime[] {
    return this.bots;
  }
  /** The bot with this id, or undefined if the id is unknown. */
  get(id: string): BotRuntime | undefined {
    return this.byId.get(id);
  }
}
