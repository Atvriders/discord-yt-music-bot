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
export type NpAction =
  | "pauseresume"
  | "skip"
  | "stop"
  | "shuffle"
  | "repeat"
  | "autodiscover"
  | "voldown"
  | "volup";

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
    case "repeat":
    case "autodiscover":
    case "voldown":
    case "volup":
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

/** Format a number of SECONDS as m:ss or h:mm:ss; "—" for missing/zero. */
function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || sec <= 0) return "—";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Format a number of MILLISECONDS as a clock string (delegates to fmtDuration). */
function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return "0:00";
  return fmtDuration(ms / 1000);
}

const BAR_WIDTH = 12;

/**
 * A simple text progress bar reflecting `positionMs / durationMs` AT EDIT TIME (no live
 * timer): `◍` marks the current position over a `▬`/`─` track, e.g. `▬▬▬▬◍───────`. With an
 * unknown duration there is no meaningful fraction, so we render an all-track bar.
 */
function progressBar(positionMs: number, durationMs: number): string {
  if (!(durationMs > 0)) return "─".repeat(BAR_WIDTH);
  const frac = Math.max(0, Math.min(1, positionMs / durationMs));
  const marker = Math.min(BAR_WIDTH - 1, Math.floor(frac * BAR_WIDTH));
  let bar = "";
  for (let i = 0; i < BAR_WIDTH; i++) {
    bar += i < marker ? "▬" : i === marker ? "◍" : "─";
  }
  return bar;
}

/** "elapsed ▬▬◍──── duration" progress line from the snapshot's position/duration. */
function progressLine(positionMs: number, durationMs: number): string {
  const elapsed = fmtMs(positionMs);
  const total = durationMs > 0 ? fmtMs(durationMs) : "—";
  return `${elapsed} ${progressBar(positionMs, durationMs)} ${total}`;
}

/** Human audio-format string from a track's AudioInfo: "opus · 160 kbps · 48 kHz". */
function fmtAudio(
  audio: { codec: string; bitrateKbps: number; sampleRateHz: number } | null,
): string | null {
  if (!audio) return null;
  const parts: string[] = [audio.codec];
  if (audio.bitrateKbps > 0) parts.push(`${audio.bitrateKbps} kbps`);
  if (audio.sampleRateHz > 0) parts.push(`${Math.round(audio.sampleRateHz / 1000)} kHz`);
  return parts.join(" · ");
}

/** Short human label for a repeat mode (used on the embed field + the repeat button). */
function repeatLabel(repeat: "off" | "one" | "all"): string {
  switch (repeat) {
    case "one":
      return "one";
    case "all":
      return "all";
    default:
      return "off";
  }
}

/** Emoji glyph for the current repeat mode (off vs one vs all). */
function repeatEmoji(repeat: "off" | "one" | "all"): string {
  return repeat === "one" ? "🔂" : "🔁";
}

/**
 * Row 1 — primary transport controls (pause/resume, skip, stop, shuffle). `paused` flips
 * the first button between ⏸ Pause and ▶ Resume.
 */
function transportRow(paused: boolean): ActionRowBuilder<ButtonBuilder> {
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

/**
 * Row 2 — secondary controls (repeat, auto-discover, vol-, vol+). Discord allows max 5
 * buttons per row, so these live on their own row. The repeat button's label reflects the
 * current mode (off/one/all); the auto-discover button shows on/off and switches its style
 * (Success when on, Secondary when off) so the live state is visible at a glance.
 */
function controlsRow(
  repeat: "off" | "one" | "all",
  autoplay: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeNpAction("repeat"))
      .setEmoji(repeatEmoji(repeat))
      .setLabel(`Repeat: ${repeatLabel(repeat)}`)
      .setStyle(repeat === "off" ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeNpAction("autodiscover"))
      .setEmoji("🔮")
      .setLabel(`Auto-discover: ${autoplay ? "on" : "off"}`)
      .setStyle(autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeNpAction("voldown"))
      .setEmoji("🔉")
      .setLabel("Vol −")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeNpAction("volup"))
      .setEmoji("🔊")
      .setLabel("Vol +")
      .setStyle(ButtonStyle.Secondary),
  );
}

function serializeRow(row: ActionRowBuilder<ButtonBuilder>): ApiButtonRow {
  return row.toJSON();
}

/**
 * Build the LIVE now-playing dashboard payload (rich embed + two control-button rows) for a
 * snapshot that has a current track. The embed carries: the title + channel + thumbnail; the
 * requester; the real audio format (when the track has been downloaded); a static progress
 * line (elapsed / duration + a text bar reflecting positionMs/durationMs AT EDIT TIME — there
 * is deliberately NO live refresh timer); the queue length; an "Up next: <title>" line; and
 * small fields for the current volume / repeat / auto-discover state. The transport row's
 * pause/resume button reflects `snapshot.paused`; the controls row's repeat + auto-discover
 * buttons reflect the live settings.
 */
export function buildNowPlayingPayload(snapshot: ControllerSnapshot): NpPayload {
  const cur = snapshot.current!;
  const queueLen = snapshot.upcoming.length;
  const upNext = snapshot.upcoming[0]?.meta.title ?? "—";
  const stateGlyph = snapshot.paused ? "⏸️" : "▶️";

  const embed = new EmbedBuilder()
    .setColor(snapshot.paused ? 0x9b9b9b : 0x1db954)
    .setAuthor({ name: `${stateGlyph} ${snapshot.paused ? "Paused" : "Now Playing"}` })
    .setTitle(cur.meta.title);
  if (cur.meta.channel) embed.setDescription(cur.meta.channel);

  embed.addFields(
    { name: "Requested by", value: cur.requester.displayName || "—", inline: true },
    { name: "Queue", value: String(queueLen), inline: true },
    { name: "Up next", value: upNext, inline: true },
    {
      name: "Progress",
      value: progressLine(cur.positionMs, cur.durationMs),
      inline: false,
    },
    { name: "Volume", value: `${snapshot.volume}%`, inline: true },
    { name: "Repeat", value: repeatLabel(snapshot.repeat), inline: true },
    { name: "Auto-discover", value: snapshot.autoplay ? "on" : "off", inline: true },
  );

  const audio = fmtAudio(cur.audio);
  if (audio) embed.addFields({ name: "Format", value: audio, inline: false });

  if (cur.meta.thumbnailUrl) embed.setThumbnail(cur.meta.thumbnailUrl);

  return {
    embeds: [embed.toJSON()],
    components: [
      serializeRow(transportRow(snapshot.paused)),
      serializeRow(controlsRow(snapshot.repeat, snapshot.autoplay)),
    ],
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
  /**
   * True while a flush's Discord I/O is in flight (between the moment the timer fires and the
   * edit settling). The schedule-time throttle treats an in-flight edit as if it "just
   * happened" so a `changed` event that lands mid-flush waits the full minEditIntervalMs from
   * the in-flight edit's completion, rather than measuring against the stale pre-flush
   * lastEditAt (which would let edits separate by only debounceMs, violating the rate limit).
   */
  flushInProgress: boolean;
  /** Epoch ms of the last completed send/edit, for the min-edit-interval throttle. */
  lastEditAt: number;
  /** The newest snapshot waiting to be rendered when the throttle window opens. */
  pending: ControllerSnapshot | null;
}

export interface NowPlayingManagerOpts {
  gateway: NpGateway;
  /** Resolve the live text channel to post in for a guild (the last `?`-command channel). */
  channelFor: (guildId: string) => string | null;
  /**
   * Resolve the guild's CONFIGURED command channel (the per-guild single-channel
   * restriction), or null when unrestricted. When this returns a channel id it takes
   * precedence over `channelFor` — the now-playing card posts in the restricted channel.
   * Optional: omit to always use the last-command channel (the original behavior).
   */
  commandChannelFor?: (guildId: string) => string | null;
  /** Debounce window for coalescing rapid `changed` bursts (ms). Default 400. */
  debounceMs?: number;
  /**
   * Minimum wall-clock interval between two consecutive send/edit calls for a guild (ms).
   * On top of the debounce, this RATE-LIMITS the message edits so a burst of rapid control
   * changes (pause→repeat→volume→…) can never hammer the Discord API: edits are coalesced and
   * the newest state is flushed once the window reopens. This is purely reactive — there is
   * NO periodic/per-second refresh; an edit only ever happens in response to a `changed`
   * event. Default 1500 ms.
   */
  minEditIntervalMs?: number;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
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
  private readonly minEditIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: NowPlayingManagerOpts) {
    this.debounceMs = opts.debounceMs ?? 400;
    this.minEditIntervalMs = opts.minEditIntervalMs ?? 1500;
    this.now = opts.now ?? (() => Date.now());
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
        flushInProgress: false,
        lastEditAt: -Infinity,
        pending: null,
      };
      this.states.set(guildId, s);
    }
    return s;
  }

  /**
   * Schedule an update from the LATEST snapshot of a `changed` burst. Two gates apply:
   *   1. debounce — coalesce a same-tick burst into one render (waits `debounceMs`),
   *   2. min-edit interval — never edit more often than `minEditIntervalMs`; when the window
   *      hasn't reopened yet, the timer is pushed out so the burst's newest state lands once.
   * The pending snapshot is always overwritten with the newest one, so an old state can never
   * win a race. This is the ONLY thing that triggers a render — there is no periodic timer.
   */
  private scheduleUpdate(guildId: string, snapshot: ControllerSnapshot): void {
    const s = this.state(guildId);
    s.pending = snapshot; // always render the freshest state
    if (s.timer) return; // a flush is already scheduled; it will pick up the new pending
    // An edit currently in flight hasn't stamped lastEditAt yet. Treat it as if it just
    // happened (sinceLast = 0) so the next flush waits the FULL minEditIntervalMs from the
    // in-flight edit, instead of the stale pre-flush lastEditAt that would collapse `wait`
    // down to debounceMs and let edits fire faster than the documented rate limit.
    const sinceLast = s.flushInProgress ? 0 : this.now() - s.lastEditAt;
    const wait = Math.max(this.debounceMs, this.minEditIntervalMs - sinceLast);
    s.timer = setTimeout(() => {
      s.timer = null;
      const next = s.pending;
      s.pending = null;
      if (next) void this.flush(guildId, next);
    }, wait);
  }

  /**
   * Apply a snapshot immediately (no debounce). Chains onto the per-guild flush promise so
   * concurrent flushes serialize. Never rejects — failures go to onError.
   */
  private flush(guildId: string, snapshot: ControllerSnapshot): Promise<void> {
    const s = this.state(guildId);
    // Mark the edit as in flight up front so a `changed` event that arrives DURING this flush's
    // Discord I/O is throttled against the in-flight edit (scheduleUpdate reads flushInProgress)
    // rather than the stale pre-flush lastEditAt.
    s.flushInProgress = true;
    s.flushing = s.flushing
      .then(() => this.render(guildId, snapshot))
      .catch((err) => {
        this.opts.onError?.(err);
      })
      // Stamp the throttle clock AFTER the I/O settles (success or failure) so the min-edit
      // interval is measured from the actual edit, gating the next burst's flush, and clear
      // the in-flight flag in the same step.
      .finally(() => {
        s.lastEditAt = this.now();
        s.flushInProgress = false;
      });
    return s.flushing;
  }

  private async render(guildId: string, snapshot: ControllerSnapshot): Promise<void> {
    const s = this.state(guildId);
    // A configured single-channel restriction wins: post in THAT channel. Otherwise fall
    // back to the last `?`-command channel (the original behavior).
    const channelId = this.opts.commandChannelFor?.(guildId) ?? this.opts.channelFor(guildId);
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
