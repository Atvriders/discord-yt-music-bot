import { loadMediaConfig, loadBotConfig } from "./config.js";
import { YouTubeService } from "./youtube/index.js";
import { AudioCache } from "./cache/index.js";
import { Semaphore } from "./util/semaphore.js";
import { GuildController } from "./orchestrator/index.js";
import { GuildHub } from "./orchestrator/hub.js";
import { createBot } from "./discord/bot.js";
import { createVoiceSession, createPassthroughResource } from "./voice/connect.js";
import type { Client } from "discord.js";

async function main(): Promise<void> {
  const media = loadMediaConfig();
  const bot = loadBotConfig();

  const youtube = new YouTubeService(media);
  const cache = new AudioCache(media.cacheDir, media.cacheMaxBytes);
  await cache.init();
  const downloads = new Semaphore(bot.maxConcurrentDownloads);

  process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

  // The hub creates one controller per guild; the controller's voice factory needs the
  // guild's channel object, which the bot resolves at connect time. We bridge via a
  // per-guild "connect" closure captured from discord.js when ensureConnected is called.
  const client: Client = createBot({
    hub: new GuildHub(
      (guildId) =>
        new GuildController(guildId, {
          youtube,
          cache,
          cacheDir: media.cacheDir,
          createSession: async (channelId) => {
            const guild = await client.guilds.fetch(guildId);
            const channel = await guild.channels.fetch(channelId);
            if (!channel?.isVoiceBased()) throw new Error("target channel is not a voice channel");
            return createVoiceSession(channel, bot.idleTimeoutMs);
          },
          makeResource: (filePath, item) => createPassthroughResource(filePath, item),
          prefetchDepth: bot.prefetchDepth,
          downloads,
        }),
    ),
    youtube,
    prefix: bot.commandPrefix,
    searchLimit: media.searchResultCount,
    adminUserIds: new Set(bot.adminUserIds),
  });

  client.on("error", (err) => console.error("[client error]", err));
  await client.login(bot.discordToken);
  console.log("discord-yt-music-bot is online");
}

void main();
