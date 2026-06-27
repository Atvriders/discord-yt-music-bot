import { loadMediaConfig, loadBotConfig, loadWebConfig } from "./config.js";
import { YouTubeService } from "./youtube/index.js";
import { AudioCache } from "./cache/index.js";
import { Semaphore } from "./util/semaphore.js";
import { GuildController } from "./orchestrator/index.js";
import { GuildHub } from "./orchestrator/hub.js";
import { createBot } from "./discord/bot.js";
import { createVoiceSession, createPassthroughResource } from "./voice/connect.js";
import type { Client } from "discord.js";
import { buildApp } from "./server/app.js";
import { GuildBroadcaster } from "./server/ws.js";
import { createLogger } from "./util/logger.js";
import { installCrashHandlers, installSignalHandlers } from "./lifecycle.js";
import { startupCanary } from "./canary.js";
import {
  collectSnapshot,
  writeSnapshot,
  readSnapshot,
  restoreSnapshot,
} from "./orchestrator/snapshot.js";

async function main(): Promise<void> {
  const media = loadMediaConfig();
  const bot = loadBotConfig();
  const log = createLogger(bot.logLevel);
  installCrashHandlers(log);

  const youtube = new YouTubeService(media);
  const cache = new AudioCache(media.cacheDir, media.cacheMaxBytes);
  await cache.init();
  const downloads = new Semaphore(bot.maxConcurrentDownloads);

  // Debounced snapshot writer — defined before hub so the factory closure captures it.
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSnapshot = (): void => {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      writeSnapshot(media.cacheDir, collectSnapshot(hub, Date.now())).catch((err) =>
        log.error({ err }, "session snapshot write failed"),
      );
    }, 3000);
  };

  const web = loadWebConfig();
  const broadcaster = new GuildBroadcaster();

  // The hub creates one controller per guild; the controller's voice factory needs the
  // guild's channel object, which the bot resolves at connect time. We bridge via a
  // per-guild "connect" closure captured from discord.js when ensureConnected is called.
  const hub = new GuildHub((guildId) => {
    const controller = new GuildController(guildId, {
      youtube,
      cache,
      cacheDir: media.cacheDir,
      // invoked lazily after client.login(); the closure over `client` is safe
      createSession: async (channelId, idleTimeoutMs) => {
        const guild = await client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(channelId);
        if (!channel?.isVoiceBased()) throw new Error("target channel is not a voice channel");
        return createVoiceSession(channel, idleTimeoutMs);
      },
      makeResource: (filePath, item, opts) => createPassthroughResource(filePath, item, opts),
      prefetchDepth: bot.prefetchDepth,
      // Initial default; the panel can override this per guild at runtime.
      idleTimeoutMs: bot.idleTimeoutMs,
      downloads,
      onTrackError: (info) => broadcaster.broadcast(guildId, { type: "trackError", ...info }),
      // Persist settings changes (debounced) so they survive a restart.
      onSettingsChange: () => scheduleSnapshot(),
    });
    // Wire debounced snapshot on queue changes.
    controller.queue.on("changed", scheduleSnapshot);
    return controller;
  });

  const client: Client = createBot({
    hub,
    youtube,
    prefix: bot.commandPrefix,
    searchLimit: media.searchResultCount,
    adminUserIds: new Set(bot.adminUserIds),
    log,
  });

  client.on("error", (err) => log.error({ err }, "[client error]"));
  await client.login(bot.discordToken);
  log.info("discord-yt-music-bot is online");
  const app = await buildApp({
    cfg: web,
    hub,
    youtube,
    client: client as never,
    adminIds: new Set(bot.adminUserIds),
    searchLimit: media.searchResultCount,
    broadcaster,
    gatewayReady: () => client.isReady(),
  });
  await app.listen({ port: web.port, host: web.host });
  log.info({ host: web.host, port: web.port }, "web panel listening");

  // Startup canary — log only, never abort.
  await startupCanary(youtube, log);

  // Restore active sessions from the last snapshot (after client is ready).
  if (!client.isReady()) {
    await new Promise<void>((res) => client.once("ready", () => res()));
  }
  const snap = await readSnapshot(media.cacheDir);
  if (snap) await restoreSnapshot(snap, hub, log);

  // Graceful shutdown: flush snapshot, leave voice sessions, close HTTP server.
  installSignalHandlers(
    [
      async () => {
        if (snapshotTimer) {
          clearTimeout(snapshotTimer);
          snapshotTimer = null;
        }
        await writeSnapshot(media.cacheDir, collectSnapshot(hub, Date.now()));
      },
      async () => {
        for (const c of hub.controllers()) await c.stop();
      },
      async () => {
        await app.close();
      },
    ],
    { graceMs: 8000 },
    log,
  );
}

void main();
