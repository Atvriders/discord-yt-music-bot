import {
  loadMediaConfig,
  loadBotConfig,
  loadWebConfig,
  materializeCookies,
  type BotInstance,
} from "./config.js";
import { YouTubeService } from "./youtube/index.js";
import { AudioCache } from "./cache/index.js";
import { Semaphore } from "./util/semaphore.js";
import { GuildController, type DownloadResult } from "./orchestrator/index.js";
import { DEFAULT_SETTINGS } from "./orchestrator/settings.js";
import { GuildHub } from "./orchestrator/hub.js";
import { PlaylistStore } from "./orchestrator/playlists.js";
import { createBot } from "./discord/bot.js";
import { NowPlayingManager, makeClientNpGateway } from "./discord/np-message.js";
import { PresenceController } from "./discord/presence.js";
import { createVoiceSession, createPassthroughResource } from "./voice/connect.js";
import { BotRegistry, type BotRuntime } from "./registry.js";
import { buildApp } from "./server/app.js";
import { GuildBroadcaster } from "./server/ws.js";
import { createLogger, setRootLogger } from "./util/logger.js";
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
  const botCfg = loadBotConfig();
  const log = createLogger(botCfg.logLevel);
  // Publish as the process-wide root so module-scope consumers (e.g. voice/connect.ts) log
  // at the configured LOG_LEVEL instead of their own hardcoded-"info" instance.
  setRootLogger(log);
  installCrashHandlers(log);

  // The Fastify app is built only after login (it needs the gateway clients). Hoist it as a
  // nullable so the shutdown tasks registered below — BEFORE login — can close it if it
  // already exists, and no-op if a signal arrives mid-startup.
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  // Resolve the effective yt-dlp cookies file BEFORE the extractor uses it: an explicit
  // YT_COOKIES path wins; otherwise inline YT_COOKIES_TEXT (pasted cookies) is written to a file.
  media.ytCookiesFile = await materializeCookies(media);
  if (media.ytCookiesFile) log.info("yt-dlp cookies enabled (age-restricted / flagged-IP support)");

  // Shared across every bot: extraction, the download cache + concurrency limiter, saved
  // playlists (a playlist belongs to a guild, not a bot), and the live-updates broadcaster.
  const youtube = new YouTubeService(media);
  const cache = new AudioCache(media.cacheDir, media.cacheMaxBytes);
  await cache.init();
  const downloads = new Semaphore(botCfg.maxConcurrentDownloads);
  // Process-wide download dedup shared by EVERY bot's controllers — they share the cache +
  // cacheDir, so two bots that cache-miss the same videoId must share one yt-dlp download.
  const sharedInFlightDownloads = new Map<string, Promise<DownloadResult>>();
  const sharedDownloadProgressSinks = new Map<
    string,
    (cb: ((percent: number) => void) | undefined) => void
  >();
  const playlists = new PlaylistStore(media.cacheDir);
  await playlists.init();
  const web = loadWebConfig();
  const broadcaster = new GuildBroadcaster();
  const adminIds = new Set(botCfg.adminUserIds);

  // Debounced, PER-BOT snapshot writer. Each bot's sessions save to their own file so restoring
  // one bot never resurrects another's queue. Defined before buildBot so the factory captures it.
  // `restoring` suppresses writes during the startup restore phase: restoring one bot fires
  // queue "changed" → scheduleSnapshot, whose timer would otherwise write EVERY bot (via the
  // shared registry) — clobbering a slower bot's not-yet-restored file with an empty snapshot.
  let restoring = true;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSnapshot = (): void => {
    if (restoring) return;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      for (const b of registry.list()) {
        writeSnapshot(media.cacheDir, collectSnapshot(b.hub, Date.now()), b.id).catch((err) =>
          log.error({ err, botId: b.id }, "session snapshot write failed"),
        );
      }
    }, 3000);
  };

  // Build ONE bot: its own gateway client, per-guild controller hub, now-playing manager, and
  // presence — all sharing the process-wide services above. The hub factory + client + np +
  // presence mirror the single-bot wiring, scoped to this bot (broadcasts key by bot id).
  function buildBot(inst: BotInstance): BotRuntime {
    // Assigned just below; the hub factory closure captures these lazily (controllers are only
    // built on the first command, long after login sets `client` and these managers).
    let presence: PresenceController | null = null;
    let nowPlaying: NowPlayingManager | null = null;
    const lastTextChannelId = new Map<string, string>();

    const hub = new GuildHub((guildId) => {
      const controller = new GuildController(guildId, {
        youtube,
        cache,
        cacheDir: media.cacheDir,
        sharedInFlightDownloads,
        sharedDownloadProgressSinks,
        createSession: async (channelId, idleTimeoutMs) => {
          const guild = await client.guilds.fetch(guildId);
          const channel = await guild.channels.fetch(channelId);
          if (!channel?.isVoiceBased()) throw new Error("target channel is not a voice channel");
          return createVoiceSession(channel, idleTimeoutMs);
        },
        makeResource: (filePath, item, opts) => createPassthroughResource(filePath, item, opts),
        prefetchDepth: botCfg.prefetchDepth,
        idleTimeoutMs: botCfg.idleTimeoutMs,
        settings: {
          ...DEFAULT_SETTINGS,
          maxTrackDurationSec: media.maxTrackDurationSec ?? 0,
          normalizeLoudness: media.normalizeLoudness,
        },
        downloads,
        // Live-updates are keyed by (botId, guildId) so the panel routes each bot's state to
        // the socket watching THAT bot.
        onTrackError: (info) =>
          broadcaster.broadcast(inst.id, guildId, { type: "trackError", guildId, ...info }),
        onTrackStart: (meta) => presence?.onTrackStart(guildId, meta.title),
        onIdle: () => presence?.onIdle(guildId),
        onSessionError: (err) => log.error({ err, guildId, botId: inst.id }, "audio player error"),
        onSettingsChange: () => scheduleSnapshot(),
        playlists,
      });
      controller.queue.on("changed", scheduleSnapshot);
      nowPlaying?.attach(guildId, controller);
      return controller;
    });

    const client = createBot({
      hub,
      youtube,
      prefix: inst.commandPrefix,
      searchLimit: media.searchResultCount,
      adminUserIds: adminIds,
      log,
      baseUrl: web.publicBaseUrl,
      onCommandChannel: (guildId, channelId) => lastTextChannelId.set(guildId, channelId),
    });

    nowPlaying = new NowPlayingManager({
      gateway: makeClientNpGateway(client),
      channelFor: (guildId) => lastTextChannelId.get(guildId) ?? null,
      commandChannelFor: (guildId) =>
        hub.has(guildId) ? hub.get(guildId).settings.commandChannelId : null,
      onError: (err) => log.warn({ err, botId: inst.id }, "[np] now-playing message update failed"),
    });
    presence = new PresenceController(client, {
      baseUrl: web.publicBaseUrl,
      prefix: inst.commandPrefix,
    });
    client.once("ready", () => presence?.applyDefault());
    client.on("error", (err) => log.error({ err, botId: inst.id }, "[client error]"));

    return {
      id: inst.id,
      name: inst.name,
      prefix: inst.commandPrefix,
      client,
      hub,
      nowPlaying,
      presence,
    };
  }

  const bots = botCfg.bots.map(buildBot);
  const registry = new BotRegistry(bots);

  // Register signal handlers BEFORE login so a SIGTERM/SIGINT arriving anywhere in the startup
  // window still flushes every bot's snapshot and tears each one down. All tasks are guarded so
  // they are safe to run at any point during startup (app null until built; empty hubs no-op).
  installSignalHandlers(
    [
      async () => {
        if (snapshotTimer) {
          clearTimeout(snapshotTimer);
          snapshotTimer = null;
        }
        for (const b of registry.list()) {
          await writeSnapshot(media.cacheDir, collectSnapshot(b.hub, Date.now()), b.id);
        }
      },
      async () => {
        for (const b of registry.list()) for (const c of b.hub.controllers()) await c.stop();
      },
      () => {
        for (const b of registry.list()) b.nowPlaying.dispose();
      },
      async () => {
        if (app) await app.close();
      },
      // Cleanly close each gateway so the bots disconnect from voice / go offline promptly on
      // restart. Ordered after controller-stop so trackEnd/idle handlers don't fire against a
      // destroyed gateway.
      async () => {
        for (const b of registry.list()) await b.client.destroy();
      },
    ],
    { graceMs: 8000 },
    log,
  );

  // Log every bot in. A single bad token fails startup (crash-and-exit) so the operator notices.
  await Promise.all(bots.map((b, i) => b.client.login(botCfg.bots[i]!.token)));
  log.info({ bots: bots.length }, "discord-yt-music-bot is online");

  app = await buildApp({
    cfg: web,
    // BotRegistry (BotRuntime[]) satisfies the REST/WS registry surface; the discord.js Client
    // isn't cleanly assignable to canControl's structural client param (same reason the old
    // single-bot wiring cast `client as never`), so cast the whole registry here.
    registry: registry as never,
    youtube,
    adminIds,
    searchLimit: media.searchResultCount,
    broadcaster,
    gatewayReady: () => registry.list().every((b) => b.client.isReady()),
  });
  await app.listen({ port: web.port, host: web.host });
  log.info({ host: web.host, port: web.port }, "web panel listening");

  // Startup canary — log only, never abort.
  await startupCanary(youtube, log);

  // Restore active sessions from each bot's last snapshot (after every gateway is ready).
  await Promise.all(
    registry
      .list()
      .map((b) =>
        b.client.isReady()
          ? Promise.resolve()
          : new Promise<void>((res) => b.client.once("ready", () => res())),
      ),
  );
  // Read EVERY bot's snapshot into memory first, then restore all bots in PARALLEL — so a slow
  // voice reconnect on one bot doesn't serialize behind the others, and (with `restoring` gating
  // scheduleSnapshot above) a mid-restore write can never clobber a file we haven't read yet.
  const snaps = await Promise.all(registry.list().map((b) => readSnapshot(media.cacheDir, b.id)));
  await Promise.all(
    registry.list().map((b, i) => {
      const snap = snaps[i];
      return snap ? restoreSnapshot(snap, b.hub, log) : Promise.resolve();
    }),
  );
  // Restore complete — re-enable the debounced snapshot writer for normal operation.
  restoring = false;
}

// A fatal startup rejection (bad config / missing DISCORD_TOKEN, failed Discord login,
// EADDRINUSE on app.listen, …) must crash-and-exit non-zero so a supervisor restarts or
// alerts — NOT get silently swallowed by installCrashHandlers' deliberately-lenient
// unhandledRejection policy. We log through pino when possible (some failures, like a bad
// env var thrown out of loadMediaConfig/loadBotConfig, happen before the logger exists, so
// fall back to console.error), then exit(1).
main().catch((err) => {
  try {
    createLogger().fatal({ err }, "startup failed");
  } catch {
    console.error("startup failed", err);
  }
  process.exit(1);
});
