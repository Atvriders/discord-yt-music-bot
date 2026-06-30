import { loadMediaConfig, loadBotConfig, loadWebConfig } from "./config.js";
import { YouTubeService } from "./youtube/index.js";
import { AudioCache } from "./cache/index.js";
import { Semaphore } from "./util/semaphore.js";
import { GuildController } from "./orchestrator/index.js";
import { DEFAULT_SETTINGS } from "./orchestrator/settings.js";
import { GuildHub } from "./orchestrator/hub.js";
import { PlaylistStore } from "./orchestrator/playlists.js";
import { createBot } from "./discord/bot.js";
import { NowPlayingManager, makeClientNpGateway } from "./discord/np-message.js";
import { PresenceController } from "./discord/presence.js";
import { createVoiceSession, createPassthroughResource } from "./voice/connect.js";
import type { Client } from "discord.js";
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
  const bot = loadBotConfig();
  const log = createLogger(bot.logLevel);
  // Publish as the process-wide root so module-scope consumers (e.g. voice/connect.ts) log
  // at the configured LOG_LEVEL instead of their own hardcoded-"info" instance.
  setRootLogger(log);
  installCrashHandlers(log);

  // The Fastify app is built only after login (it needs the gateway client). Hoist it as a
  // nullable so the shutdown tasks registered below — BEFORE login — can close it if it
  // already exists, and no-op if a signal arrives mid-startup.
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  const youtube = new YouTubeService(media);
  const cache = new AudioCache(media.cacheDir, media.cacheMaxBytes);
  await cache.init();
  const downloads = new Semaphore(bot.maxConcurrentDownloads);

  // Per-guild saved playlists, persisted under the media cache dir (loaded once at boot).
  const playlists = new PlaylistStore(media.cacheDir);
  await playlists.init();

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

  // Reflects playback in the bot's (global) Discord presence. Assigned after the gateway
  // client exists; the hub factory below captures it lazily (controllers are only built
  // after login, by which point `presence` is set). Best-effort — never affects playback.
  let presence: PresenceController | null = null;

  // Per-guild "last command text channel" — the channel the most recent `?`-command ran
  // in. The live now-playing message posts here; we only post once it's known.
  const lastTextChannelId = new Map<string, string>();

  // Live now-playing message manager. Assigned after the gateway client exists (its
  // gateway needs client.channels); the hub factory below captures it lazily and attaches
  // each controller as it is created. Best-effort — never affects playback.
  let nowPlaying: NowPlayingManager | null = null;

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
      // Seed the per-guild max-track-length from the configured ceiling (null = no
      // limit -> 0); the panel can raise/lower or disable it per guild at runtime.
      settings: {
        ...DEFAULT_SETTINGS,
        maxTrackDurationSec: media.maxTrackDurationSec ?? 0,
        normalizeLoudness: media.normalizeLoudness,
      },
      downloads,
      onTrackError: (info) =>
        broadcaster.broadcast(guildId, { type: "trackError", guildId, ...info }),
      // Reflect the freshly-started track in the bot's global presence ("Listening to …").
      onTrackStart: (meta) => presence?.onTrackStart(guildId, meta.title),
      // Revert presence to the default when this guild's session goes idle.
      onIdle: () => presence?.onIdle(guildId),
      // AudioPlayer stream errors are logged for observability; queue recovery happens via
      // the Playing->Idle trackEnd path, so we deliberately do NOT advance from here.
      onSessionError: (err) => log.error({ err, guildId }, "audio player error"),
      // Persist settings changes (debounced) so they survive a restart.
      onSettingsChange: () => scheduleSnapshot(),
      // Shared per-guild saved-playlist store (persists itself on save/delete).
      playlists,
    });
    // Wire debounced snapshot on queue changes.
    controller.queue.on("changed", scheduleSnapshot);
    // Wire the live now-playing message (post/edit/finalize) off playback changes. The
    // manager is created post-login but always before any controller (controllers are only
    // built on the first command, by which point the gateway is up). Best-effort.
    nowPlaying?.attach(guildId, controller);
    return controller;
  });

  const client: Client = createBot({
    hub,
    youtube,
    prefix: bot.commandPrefix,
    searchLimit: media.searchResultCount,
    adminUserIds: new Set(bot.adminUserIds),
    log,
    // Drives the "Panel:" line in the bot's About Me; built from the real configured URL.
    baseUrl: web.publicBaseUrl,
    // Track where each guild's last command ran so the live now-playing message posts there.
    onCommandChannel: (guildId, channelId) => lastTextChannelId.set(guildId, channelId),
  });

  // Now that the gateway client exists, build the now-playing manager (its gateway adapts
  // client.channels). Controllers created earlier in this tick (none yet) and all future
  // ones attach via the hub factory closure above. Failures are logged, never thrown.
  nowPlaying = new NowPlayingManager({
    gateway: makeClientNpGateway(client),
    channelFor: (guildId) => lastTextChannelId.get(guildId) ?? null,
    // When a guild has a single-channel restriction configured, post the now-playing card
    // in THAT channel (takes precedence over the last-command channel). Read from the live
    // controller settings; `has` avoids creating a controller just to look this up.
    commandChannelFor: (guildId) =>
      hub.has(guildId) ? hub.get(guildId).settings.commandChannelId : null,
    onError: (err) => log.warn({ err }, "[np] now-playing message update failed"),
  });

  // Now that the gateway client exists, build the presence controller the hub factory
  // captured. Apply the default presence once the gateway is ready so the bot shows
  // "Listening to ?help · <panel>" before anything has played.
  presence = new PresenceController(client, { baseUrl: web.publicBaseUrl });
  client.once("ready", () => presence?.applyDefault());

  client.on("error", (err) => log.error({ err }, "[client error]"));

  // Register signal handlers BEFORE login (and before app.listen/canary/restore) so a
  // SIGTERM/SIGINT arriving anywhere in the startup window still flushes the snapshot and
  // tears down whatever is already up. `app` is null until built (line below), and the
  // controllers()/client teardown are no-ops if nothing is running yet — every task is
  // guarded so it is safe to run at any point during startup.
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
      // Cancel any pending now-playing edit timers (debounced) so they don't fire mid-teardown.
      () => {
        nowPlaying?.dispose();
      },
      async () => {
        if (app) await app.close();
      },
      // Cleanly close the Discord gateway so the bot disconnects from voice / goes offline
      // promptly on restart instead of lingering until the socket times out. Ordered after
      // controller-stop so trackEnd/idle handlers don't fire against a destroyed gateway.
      async () => {
        await client.destroy();
      },
    ],
    { graceMs: 8000 },
    log,
  );

  await client.login(bot.discordToken);
  log.info("discord-yt-music-bot is online");
  app = await buildApp({
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
  // Signal handlers were registered before login (above) so the entire startup window is
  // covered; nothing more to wire here.
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
