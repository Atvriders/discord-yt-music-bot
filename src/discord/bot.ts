import {
  Client,
  GatewayIntentBits,
  Events,
  GuildMember,
  type Message,
  type Interaction,
} from "discord.js";
import { parseCommand } from "./command-parser.js";
import { handleCommand } from "./handlers.js";
import { decodePick } from "./picker.js";
import { selectVoiceChannel } from "../orchestrator/voice-selection.js";
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
  log: Pick<Logger, "info" | "error">;
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

  client.on(Events.MessageCreate, async (message) => {
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
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
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
      await interaction.reply({ content: `❌ ${target.reason}`, ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    try {
      const meta = await deps.youtube.resolve(videoId);
      const controller = deps.hub.get(interaction.guildId);
      await controller.ensureConnected(target.channelId);
      await controller.enqueue(meta, {
        discordUserId: interaction.user.id,
        displayName: interaction.user.username,
        avatarUrl: interaction.user.displayAvatarURL(),
        source: "discord",
      });
      await interaction.editReply({ content: `➕ Queued **${meta.title}**.`, components: [] });
    } catch {
      await interaction.editReply({ content: "❌ Failed to queue that result.", components: [] });
    }
  });

  return client;
}
