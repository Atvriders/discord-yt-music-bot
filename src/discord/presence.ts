import { ActivityType, type Client } from "discord.js";

/**
 * Drives the bot's Discord presence ("status") to reflect playback. Presence is a single
 * GLOBAL property of the user — there is one across every guild — so we show the
 * MOST-RECENTLY-STARTED track and remember which guild owns it. When that guild goes
 * idle we fall back to a default ("Listening to ?help · <panel>"). Everything here is
 * best-effort: setActivity is guarded so a gateway hiccup can never crash playback.
 */

/** Discord caps an activity name at 128 characters. */
export const ACTIVITY_NAME_MAX = 128;

/** Command prefix used for the idle hint when a bot doesn't specify its own. */
const DEFAULT_PREFIX = "?";

export interface PresenceActivity {
  name: string;
  type: ActivityType.Listening;
}

function clamp(name: string): string {
  if (name.length <= ACTIVITY_NAME_MAX) return name;
  return name.slice(0, ACTIVITY_NAME_MAX - 1) + "…";
}

/**
 * Build the activity to display. With a `title`, it's "Listening to <title>". With no
 * title (nothing playing anywhere) it's the default help/panel hint. Pure + testable.
 */
export function buildPresenceActivity(
  title: string | null | undefined,
  baseUrl: string | undefined,
  prefix: string = DEFAULT_PREFIX,
): PresenceActivity {
  if (title && title.trim().length > 0) {
    return { name: clamp(title.trim()), type: ActivityType.Listening };
  }
  const hint = `${prefix}help`;
  const name = baseUrl ? `${hint} · ${baseUrl}` : hint;
  return { name: clamp(name), type: ActivityType.Listening };
}

export interface PresenceOptions {
  /** Public panel URL, shown in the idle/default presence. Optional. */
  baseUrl?: string;
  /** This bot's command prefix, shown in the idle hint as "<prefix>help". Defaults to "?". */
  prefix?: string;
}

export class PresenceController {
  // The guild whose track is currently reflected in the presence, or null when idle.
  private holder: string | null = null;

  constructor(
    private readonly client: Pick<Client, "user">,
    private readonly opts: PresenceOptions = {},
  ) {}

  /** A track started in `guildId`; take over the (global) presence and show its title. */
  onTrackStart(guildId: string, title: string): void {
    this.holder = guildId;
    this.apply(buildPresenceActivity(title, this.opts.baseUrl, this.opts.prefix));
  }

  /**
   * `guildId` stopped playing. Only revert to the default presence if that guild is the
   * one currently OWNING the presence — otherwise another guild is still playing and its
   * track should keep showing.
   */
  onIdle(guildId: string): void {
    if (this.holder !== guildId) return;
    this.holder = null;
    this.apply(buildPresenceActivity(null, this.opts.baseUrl, this.opts.prefix));
  }

  /** Force the default presence (e.g. once at startup before anything has played). */
  applyDefault(): void {
    this.holder = null;
    this.apply(buildPresenceActivity(null, this.opts.baseUrl, this.opts.prefix));
  }

  private apply(activity: PresenceActivity): void {
    try {
      this.client.user?.setActivity(activity.name, { type: activity.type });
    } catch {
      // Best-effort cosmetic update; a gateway/availability error must never propagate.
    }
  }
}
