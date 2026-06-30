import {
  Client,
  GatewayIntentBits,
  Events,
  GuildMember,
  Routes,
  type Message,
  type Interaction,
} from "discord.js";
import { parseCommand } from "./command-parser.js";
import { handleCommand } from "./handlers.js";
import { decodePick } from "./picker.js";
import { buildBotBio } from "./bio.js";
import { decodeNpAction, type NpAction } from "./np-message.js";
import { selectVoiceChannel } from "../orchestrator/voice-selection.js";
import { canControl } from "../auth/authz.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import { VOLUME_MAX, type RepeatMode } from "../orchestrator/settings.js";
import type { GuildHub } from "../orchestrator/hub.js";
import type { GuildController } from "../orchestrator/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { Requester } from "../types/index.js";
import type { Logger } from "pino";

export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] as const;

export interface BotDeps {
  hub: GuildHub;
  youtube: YouTubeService;
  prefix: string;
  searchLimit: number;
  adminUserIds: ReadonlySet<string>;
  log: Pick<Logger, "info" | "warn" | "error">;
  // The public web-panel base URL (WebConfig.publicBaseUrl), used to add the "Panel:"
  // line to the bot's About Me. Optional: omit when running without the web panel.
  baseUrl?: string;
  /**
   * Called whenever a `?`-command runs in a guild, with the text channel it ran in. The
   * host stores this as the guild's "last command channel" so the live now-playing
   * manager knows where to post. Optional — omit when running without the panel/np feature.
   */
  onCommandChannel?: (guildId: string, channelId: string) => void;
}

/** Volume step (percent) applied by the now-playing 🔉/🔊 buttons; clamped to 0–VOLUME_MAX. */
const NP_VOLUME_STEP = 10;

/** Next repeat mode in the off → one → all → off cycle (the 🔁 button). */
function nextRepeat(repeat: RepeatMode): RepeatMode {
  switch (repeat) {
    case "off":
      return "one";
    case "one":
      return "all";
    default:
      return "off";
  }
}

/** Apply a now-playing control-button action to a guild controller. Shared by the button
 * router so the mapping customId -> action -> controller method lives in one place. */
export async function applyNpAction(
  controller: Pick<
    GuildController,
    | "isPaused"
    | "pause"
    | "resume"
    | "skip"
    | "stop"
    | "shuffle"
    | "settings"
    | "updateSettings"
    | "setVolume"
  >,
  action: NpAction,
): Promise<void> {
  switch (action) {
    case "pauseresume":
      if (controller.isPaused) controller.resume();
      else controller.pause();
      return;
    case "skip":
      controller.skip();
      return;
    case "stop":
      await controller.stop();
      return;
    case "shuffle":
      await controller.shuffle();
      return;
    case "repeat":
      controller.updateSettings({ repeat: nextRepeat(controller.settings.repeat) });
      return;
    case "autodiscover":
      controller.updateSettings({ autoplay: !controller.settings.autoplay });
      return;
    case "voldown":
      controller.setVolume(clampVolume(controller.settings.volume - NP_VOLUME_STEP));
      return;
    case "volup":
      controller.setVolume(clampVolume(controller.settings.volume + NP_VOLUME_STEP));
      return;
  }
}

/** Clamp a volume percentage into the allowed 0–VOLUME_MAX range. */
function clampVolume(pct: number): number {
  return Math.max(0, Math.min(VOLUME_MAX, pct));
}

/**
 * Ephemeral confirmation text for a now-playing button, reflecting the RESULTING state read
 * back from the controller AFTER applyNpAction. Returns null for the transport buttons
 * (pause/resume/skip/stop/shuffle) whose effect is already obvious from the edited card, so
 * we don't spam a confirmation for them. The secondary controls (repeat/auto-discover/volume)
 * confirm the new value since it's a discrete toggle/step the user may want feedback on.
 */
function npConfirmation(
  action: NpAction,
  controller: Pick<GuildController, "settings">,
): string | null {
  const s = controller.settings;
  switch (action) {
    case "repeat":
      return `🔁 Repeat: **${s.repeat}**.`;
    case "autodiscover":
      return `🔮 Auto-discover: **${s.autoplay ? "on" : "off"}**.`;
    case "voldown":
    case "volup":
      return `🔊 Volume: **${s.volume}%**.`;
    default:
      return null;
  }
}

/**
 * Push the bot's "About Me" (the Discord application description) to a freshly-built
 * bio. Best-effort: any failure is logged at warn and swallowed so it can never block
 * or crash startup, nor affect the gateway/playback. Returns true on success.
 *
 * Uses discord.js v14's `client.application.edit({ description })` when available, and
 * falls back to the raw REST route for resilience against minor API surface changes.
 */
export async function setBotBio(
  client: Client,
  bio: string,
  log: Pick<Logger, "warn">,
): Promise<boolean> {
  try {
    const application = client.application;
    if (application && typeof application.edit === "function") {
      await application.edit({ description: bio });
    } else {
      await client.rest.patch(Routes.currentApplication(), { body: { description: bio } });
    }
    return true;
  } catch (err) {
    log.warn({ err }, "[bot] failed to update application description (About Me)");
    return false;
  }
}

function requesterOf(message: Message, source: "discord" | "web" = "discord"): Requester {
  const user = message.author;
  return {
    discordUserId: user.id,
    displayName: message.member?.displayName ?? user.username,
    avatarUrl: user.displayAvatarURL(),
    source,
  };
}

export function createBot(deps: BotDeps): Client {
  const client = new Client({ intents: [...REQUIRED_INTENTS] });

  const onMessage = async (message: Message): Promise<void> => {
    if (message.author.bot || !message.inGuild()) return;
    const cmd = parseCommand(message.content, deps.prefix);
    if (cmd.kind === "none") return;

    const controller = deps.hub.get(message.guildId);

    // Single-channel restriction: when a command channel is configured, only accept
    // commands sent in THAT channel. EXCEPTION: `?channel` is always allowed (so an admin
    // can re-point or clear the restriction from anywhere and never lock themselves out).
    // Silent ignore — we don't reply in other channels to avoid spamming them.
    const commandChannelId = controller.settings.commandChannelId;
    if (commandChannelId && message.channelId !== commandChannelId && cmd.kind !== "channel") {
      return;
    }

    // Remember the text channel of the most recent command for this guild so the live
    // now-playing message can be posted there (the fallback when no command channel is
    // configured). Best-effort; the host swallows failures.
    deps.onCommandChannel?.(message.guildId, message.channelId);

    try {
      const result = await handleCommand(cmd, {
        controller,
        youtube: deps.youtube,
        requester: requesterOf(message),
        requesterChannelId: message.member?.voice.channelId ?? null,
        botChannelId: message.guild.members.me?.voice.channelId ?? null,
        channelId: message.channelId,
        isAdmin: deps.adminUserIds.has(message.author.id),
        searchLimit: deps.searchLimit,
      });

      if (result.type === "picker") {
        await message.reply({ content: result.content, components: result.components });
      } else {
        await message.reply(result.content);
      }
    } catch (err) {
      deps.log.error({ err }, "[bot] command failed");
      await message.reply("❌ Something went wrong handling that command.").catch(() => {});
    }
  };
  // Listeners must return void; invoke the async handler and log any rejection that
  // escapes its internal try/catch (e.g. a Discord API error on the reply itself) so
  // it never becomes an unhandled rejection that could crash the process.
  client.on(Events.MessageCreate, (message) => {
    void onMessage(message).catch((err: unknown) =>
      deps.log.error({ err }, "[bot] message handler crashed"),
    );
  });

  const onInteraction = async (interaction: Interaction): Promise<void> => {
    if (!interaction.isButton()) return;

    // Live now-playing control buttons (pause/resume, skip, stop, shuffle). Authorized by
    // the same membership/admin check the panel uses (canControl), then routed to the
    // controller action and reflected in the message.
    const npAction = decodeNpAction(interaction.customId);
    if (npAction && interaction.inGuild()) {
      // Acknowledge FIRST, before any async work. A Discord interaction token expires in 3s,
      // and canControl() below awaits guild.members.fetch() (a REST call that can consume the
      // whole window on a large/cold-cache guild). Deferring up front makes the ack
      // latency-independent so the button can never get stuck on a slow member fetch. Log the
      // (rare) defer failure instead of swallowing it silently, so stuck-button cases are
      // diagnosable; after a failed defer every later reply/followUp would also reject, so bail.
      try {
        await interaction.deferUpdate();
      } catch (err) {
        deps.log.warn({ err }, "[bot] now-playing button deferUpdate failed");
        return;
      }
      const allowed = await canControl(
        client as never,
        interaction.user.id,
        interaction.guildId,
        deps.adminUserIds,
      ).catch(() => false);
      if (!allowed) {
        // Already deferred — must use followUp (not reply) to surface the denial ephemerally.
        await interaction
          .followUp({
            content: "❌ You don't have permission to control playback here.",
            ephemeral: true,
          })
          .catch(() => {});
        return;
      }
      try {
        const controller = deps.hub.get(interaction.guildId);
        await applyNpAction(controller, npAction);
        // The controller emits "changed", which the now-playing manager debounces into an
        // edit of this very message — so we don't re-edit it here. We DO surface a small
        // ephemeral confirmation reflecting the resulting state (only the requester sees it),
        // best-effort: a failed confirmation must never escape the handler.
        const confirmation = npConfirmation(npAction, controller);
        if (confirmation) {
          await interaction.followUp({ content: confirmation, ephemeral: true }).catch(() => {});
        }
      } catch (err) {
        deps.log.error({ err }, "[bot] now-playing control failed");
        await interaction
          .followUp({ content: "❌ That control didn't work.", ephemeral: true })
          .catch(() => {});
      }
      return;
    }

    const videoId = decodePick(interaction.customId);
    if (!videoId || !interaction.inGuild()) return;

    const member = interaction.member;
    const requesterChannelId =
      member instanceof GuildMember ? (member.voice.channelId ?? null) : null;
    const botChannelId = interaction.guild?.members.me?.voice.channelId ?? null;
    const target = selectVoiceChannel({
      requesterChannelId,
      botChannelId,
      isAdmin: deps.adminUserIds.has(interaction.user.id),
    });
    if (!target.ok) {
      // Guard the acknowledgement: a failed reply (expired token, network error)
      // must not escape the async handler as an unhandled rejection.
      await interaction.reply({ content: `❌ ${target.reason}`, ephemeral: true }).catch(() => {});
      return;
    }
    // Acknowledge first. If the defer itself fails (3s window elapsed, token reused,
    // network error), bail — every later editReply targets an unacknowledged
    // interaction and would also reject, so there is nothing useful to surface.
    try {
      await interaction.deferUpdate();
    } catch {
      return;
    }
    try {
      const meta = await deps.youtube.resolve(videoId);
      const controller = deps.hub.get(interaction.guildId);
      if (target.move) await controller.moveTo(target.channelId);
      else await controller.ensureConnected(target.channelId);
      await controller.enqueue(meta, {
        discordUserId: interaction.user.id,
        displayName: interaction.user.username,
        avatarUrl: interaction.user.displayAvatarURL(),
        source: "discord",
      });
      await interaction
        .editReply({ content: `➕ Queued **${meta.title}**.`, components: [] })
        .catch(() => {});
    } catch (err) {
      // Surface a concrete reason instead of an opaque "failed to queue". The
      // per-guild max-track-length guard carries a human message ("Too long — max
      // Nh …"); show it verbatim. Other YtErrors surface their kind. Each editReply
      // is guarded so a failed recovery (e.g. the token expired between deferUpdate
      // and now) cannot escape as a second unhandled rejection.
      if (err instanceof YtError && err.kind === YtErrorKind.TooLong) {
        await interaction
          .editReply({ content: `❌ ${err.message}`, components: [] })
          .catch(() => {});
      } else {
        const reason = err instanceof YtError ? ` (${err.kind})` : "";
        await interaction
          .editReply({
            content: `❌ Failed to queue that result${reason}.`,
            components: [],
          })
          .catch(() => {});
      }
    }
  };
  client.on(Events.InteractionCreate, (interaction) => {
    void onInteraction(interaction).catch((err: unknown) =>
      deps.log.error({ err }, "[bot] interaction handler crashed"),
    );
  });

  // Once the gateway is ready, set the bot's "About Me" from the live config. The bio
  // is built from the actual prefix/URL so it never drifts. This is purely cosmetic and
  // best-effort: setBotBio swallows and logs any failure, and we use `once` so a single
  // attempt per session never re-fires on reconnects.
  client.once(Events.ClientReady, () => {
    const bio = buildBotBio({ prefix: deps.prefix, baseUrl: deps.baseUrl });
    void setBotBio(client, bio, deps.log);
  });

  return client;
}
