export interface MediaConfig {
  cacheDir: string;
  cacheMaxBytes: number;
  historyMaxItems: number;
  searchResultCount: number;
  maxTrackDurationSec: number | null;
  normalizeLoudness: boolean;
  ytProxy: string | null;
  ytCookiesFile: string | null;
  poTokenProviderUrl: string | null;
  sponsorblockRemove: string | null;
  playerClients: string;
  ytdlpTimeoutMs: number;
}

/**
 * One Discord bot in the multi-bot list. The whole app runs a LIST of these so two+ bots can
 * each play a DIFFERENT song in different voice channels (each gets its own discord.js Client +
 * GuildHub), while sharing one YouTubeService/AudioCache/downloads-Semaphore/playlists/Fastify.
 * id is "1","2","3",... (the string of the 1-based index).
 */
export interface BotInstance {
  id: string;
  token: string;
  commandPrefix: string;
  name: string;
}

export interface BotConfig {
  bots: BotInstance[];
  idleTimeoutMs: number;
  prefetchDepth: number;
  maxConcurrentDownloads: number;
  adminUserIds: string[];
  logLevel: string;
}

export interface WebConfig {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  redirectUri: string;
  sessionSecret: string;
  port: number;
  host: string;
  trustProxy: boolean;
  allowedWsOrigins: string[];
  nodeEnv: string;
  secureCookies: boolean;
}
