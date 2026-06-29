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
import { selectVoiceChannel } from "../orchestrator/voice-selection.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import type { GuildHub } from "../orchestrator/hub.js";
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

    try {
      const controller = deps.hub.get(message.guildId);
      const result = await handleCommand(cmd, {
        controller,
        youtube: deps.youtube,
        requester: requesterOf(message),
        requesterChannelId: message.member?.voice.channelId ?? null,
        botChannelId: message.guild.members.me?.voice.channelId ?? null,
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
