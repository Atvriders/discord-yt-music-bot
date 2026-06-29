import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
} from "discord.js";
import type { ControllerSnapshot } from "../orchestrator/index.js";

/** The serialized action-row shape produced by ActionRowBuilder<ButtonBuilder>.toJSON(). */
type ApiButtonRow = ReturnType<ActionRowBuilder<ButtonBuilder>["toJSON"]>;

/**
 * Live "now playing" message: a per-guild Discord embed with a control-button row
 * (pause/resume, skip, stop, shuffle) that EDITS in place as tracks change and is
 * finalized ("Stopped") when playback goes idle.
 *
 * Everything here is BEST-EFFORT: the manager never throws into the playback path. It
 * is decoupled from the real discord.js Client via the small `NpGateway` interface so it
 * can be driven by a fake in tests and a thin client adapter in production.
 */

/** The control actions a now-playing button can trigger. */
export type NpAction = "pauseresume" | "skip" | "stop" | "shuffle";

const PREFIX = "np";

/** customId encoding for a now-playing control button: `np:<action>`. */
export function encodeNpAction(action: NpAction): string {
  return `${PREFIX}:${action}`;
}

/** Decode a now-playing control-button customId, or null if it isn't one of ours. */
export function decodeNpAction(customId: string): NpAction | null {
  if (!customId.startsWith(`${PREFIX}:`)) return null;
  const action = customId.slice(PREFIX.length + 1);
  switch (action) {
    case "pauseresume":
    case "skip":
    case "stop":
    case "shuffle":
      return action;
    default:
      return null;
  }
}

/** A serialized message payload (embed + button rows) ready to send or edit. */
export interface NpPayload {
  embeds: APIEmbed[];
  components: ApiButtonRow[];
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || sec <= 0) return "—";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The control-button row. `paused` flips the first button between ⏸ Pause and ▶ Resume. */
function buttonRow(paused: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeNpAction("pauseresume"))
      .setEmoji(paused ? "▶️" : "⏸️")
      .setLabel(paused ? "Resume" : "Pause")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeNpAction("skip"))
      .setEmoji("⏭️")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeNpAction("stop"))
      .setEmoji("⏹️")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeNpAction("shuffle"))
      .setEmoji("🔀")
      .setLabel("Shuffle")
      .setStyle(ButtonStyle.Secondary),
  );
}

function serializeRow(row: ActionRowBuilder<ButtonBuilder>): ApiButtonRow {
  return row.toJSON();
}

/**
 * Build the LIVE now-playing payload (embed + control buttons) for a snapshot that has a
 * current track. Title, thumbnail, requester, and duration come from the current item; the
 * pause/resume button reflects `snapshot.paused`.
 */
export function buildNowPlayingPayload(snapshot: ControllerSnapshot): NpPayload {
  const cur = snapshot.current!;
  const upcoming = snapshot.upcoming.length;
  const embed = new EmbedBuilder()
    .setColor(snapshot.paused ? 0x9b9b9b : 0x1db954)
    .setAuthor({ name: snapshot.paused ? "Paused" : "Now Playing" })
    .setTitle(cur.meta.title)
    .addFields(
      { name: "Requested by", value: cur.requester.displayName || "—", inline: true },
      { name: "Duration", value: fmtDuration(cur.meta.durationSec), inline: true },
      {
        name: "Up next",
        value: upcoming > 0 ? `${upcoming} track${upcoming === 1 ? "" : "s"}` : "—",
        inline: true,
      },
    );
  if (cur.meta.thumbnailUrl) embed.setThumbnail(cur.meta.thumbnailUrl);
  return {
    embeds: [embed.toJSON()],
    components: [serializeRow(buttonRow(snapshot.paused))],
  };
}

/**
 * Build the FINALIZED payload shown when playback stops/idles. The buttons are dropped
 * (the controls are dead once playback is over) and the embed reads "Stopped". `lastTitle`
 * is the track that was playing, if known, so the finalized card still names it.
 */
export function buildStoppedPayload(lastTitle?: string | null): NpPayload {
  const embed = new EmbedBuilder()
    .setColor(0x4f545c)
    .setAuthor({ name: "Stopped" })
    .setTitle(lastTitle ?? "Playback ended");
  return { embeds: [embed.toJSON()], components: [] };
}

/**
 * Minimal Discord channel surface the manager needs. Implemented for real over a
 * discord.js Client (see makeClientNpGateway) and faked in tests. Every method is async
 * and may reject; the manager treats a rejecting `edit` as "message gone" and reposts.
 */
export interface NpGateway {
  /** Post a new message in the channel; resolves to the created message id. */
  send(channelId: string, payload: NpPayload): Promise<string>;
  /** Edit an existing message; rejects if the message was deleted. */
  edit(channelId: string, messageId: string, payload: NpPayload): Promise<void>;
  /**
   * The id of the most recent message in the channel, or null if unknown. Used to detect
   * that our message is no longer the latest (so we repost rather than edit a buried card).
   */
  latestMessageId(channelId: string): Promise<string | null>;
}

/**
 * Adapt a discord.js Client to the NpGateway. Best-effort: every call resolves a text
 * channel by id and sends/edits a message on it. `edit` rejects (as the contract requires)
 * when the target message was deleted — discord.js throws "Unknown Message", which the
 * manager catches and turns into a repost.
 */
export function makeClientNpGateway(client: {
  channels: {
    fetch(id: string): Promise<unknown>;
  };
}): NpGateway {
  async function textChannel(channelId: string): Promise<{
    send(payload: NpPayload): Promise<{ id: string }>;
    messages: {
      edit(messageId: string, payload: NpPayload): Promise<unknown>;
      fetch(opts: { limit: number }): Promise<Map<string, { id: string }>>;
    };
    lastMessageId?: string | null;
  }> {
    const channel = (await client.channels.fetch(channelId)) as {
      isTextBased?: () => boolean;
      send: (payload: NpPayload) => Promise<{ id: string }>;
      messages: {
        edit(messageId: string, payload: NpPayload): Promise<unknown>;
        fetch(opts: { limit: number }): Promise<Map<string, { id: string }>>;
      };
      lastMessageId?: string | null;
    } | null;
    if (!channel || (channel.isTextBased && !channel.isTextBased())) {
      throw new Error("target channel is not text-based");
    }
    return channel;
  }

  return {
    async send(channelId, payload) {
      const channel = await textChannel(channelId);
      const message = await channel.send(payload);
      return message.id;
    },
    async edit(channelId, messageId, payload) {
      const channel = await textChannel(channelId);
      await channel.messages.edit(messageId, payload);
    },
    async latestMessageId(channelId) {
      const channel = await textChannel(channelId);
      // Prefer the cheap cached pointer; fall back to a 1-message history fetch.
      if (typeof channel.lastMessageId === "string") return channel.lastMessageId;
      const recent = await channel.messages.fetch({ limit: 1 });
      const first = [...recent.values()][0];
      return first ? first.id : null;
    },
  };
}

interface ControllerLike {
  on(event: "changed", listener: () => void): unknown;
  snapshot(): ControllerSnapshot;
}

interface GuildState {
  channelId: string;
  messageId: string | null;
  /** Title of the last track we rendered (for the finalized "Stopped" card). */
  lastTitle: string | null;
  /** Whether the current message is already a finalized "Stopped" card. */
  finalized: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Serializes send/edit so two debounced flushes can't race a double-post. */
  flushing: Promise<void>;
}

export interface NowPlayingManagerOpts {
  gateway: NpGateway;
  /** Resolve the live text channel to post in for a guild (the last `?`-command channel). */
  channelFor: (guildId: string) => string | null;
  /** Debounce window for coalescing rapid `changed` bursts (ms). Default 400. */
  debounceMs?: number;
  /** Best-effort failure sink (logging only). */
  onError?: (err: unknown) => void;
}

/**
 * Per-guild now-playing message manager. Hook `attach(guildId, controller)` once per
 * guild; thereafter every controller "changed" event debounces an update() that posts /
 * edits / finalizes the live message. All Discord I/O is best-effort and swallowed.
 */
export class NowPlayingManager {
  private readonly states = new Map<string, GuildState>();
  private readonly attached = new Set<string>();
  private readonly debounceMs: number;

  constructor(private readonly opts: NowPlayingManagerOpts) {
    this.debounceMs = opts.debounceMs ?? 400;
  }

  /** Wire a guild's controller so playback changes drive its live message. Idempotent. */
  attach(guildId: string, controller: ControllerLike): void {
    if (this.attached.has(guildId)) return;
    this.attached.add(guildId);
    controller.on("changed", () => this.scheduleUpdate(guildId, controller.snapshot()));
  }

  private state(guildId: string): GuildState {
    let s = this.states.get(guildId);
    if (!s) {
      s = {
        channelId: "",
        messageId: null,
        lastTitle: null,
        finalized: false,
        timer: null,
        flushing: Promise.resolve(),
      };
      this.states.set(guildId, s);
    }
    return s;
  }

  /** Debounce an update from the latest snapshot. Safe to call from any "changed" burst. */
  private scheduleUpdate(guildId: string, snapshot: ControllerSnapshot): void {
    const s = this.state(guildId);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      void this.flush(guildId, snapshot);
    }, this.debounceMs);
  }

  /**
   * Apply a snapshot immediately (no debounce). Chains onto the per-guild flush promise so
   * concurrent flushes serialize. Never rejects — failures go to onError.
   */
  private flush(guildId: string, snapshot: ControllerSnapshot): Promise<void> {
    const s = this.state(guildId);
    s.flushing = s.flushing
      .then(() => this.render(guildId, snapshot))
      .catch((err) => {
        this.opts.onError?.(err);
      });
    return s.flushing;
  }

  private async render(guildId: string, snapshot: ControllerSnapshot): Promise<void> {
    const s = this.state(guildId);
    const channelId = this.opts.channelFor(guildId);
    if (!channelId) return; // no known command channel yet — post nothing

    // Playback active → live card. Otherwise → finalize ("Stopped").
    if (snapshot.current) {
      s.lastTitle = snapshot.current.meta.title;
      s.finalized = false;
      await this.upsert(s, channelId, buildNowPlayingPayload(snapshot));
    } else {
      // Idle: finalize an existing card once. Don't post a fresh "Stopped" card out of
      // nowhere when we never had a live message (e.g. a bare ?stop with nothing playing).
      if (s.messageId === null || s.finalized) return;
      s.finalized = true;
      await this.upsert(s, channelId, buildStoppedPayload(s.lastTitle), { allowRepost: false });
    }
  }

  /**
   * Create-or-edit the live message. Reposts (sends a new message) when there is no message
   * yet, when the message was deleted (edit rejects), or when our message is no longer the
   * latest in the channel — UNLESS `allowRepost` is false (finalize must not resurrect a
   * deleted card as a new "Stopped" message).
   */
  private async upsert(
    s: GuildState,
    channelId: string,
    payload: NpPayload,
    opts: { allowRepost?: boolean } = {},
  ): Promise<void> {
    const allowRepost = opts.allowRepost ?? true;
    const channelChanged = s.channelId !== channelId;
    s.channelId = channelId;

    if (s.messageId !== null && !channelChanged) {
      // Repost if our message is buried (no longer the latest) so it stays visible.
      let buried = false;
      if (allowRepost) {
        const latest = await this.opts.gateway.latestMessageId(channelId).catch(() => null);
        buried = latest !== null && latest !== s.messageId;
      }
      if (!buried) {
        try {
          await this.opts.gateway.edit(channelId, s.messageId, payload);
          return;
        } catch {
          // Edit failed → message was deleted. Fall through to repost (if allowed).
          s.messageId = null;
        }
      } else {
        s.messageId = null;
      }
    }

    if (!allowRepost) return; // finalize: don't create a new message if the old one is gone
    s.messageId = await this.opts.gateway.send(channelId, payload);
  }

  /** Cancel any pending timers (shutdown). */
  dispose(): void {
    for (const s of this.states.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
  }
}
