export interface MediaConfig {
  cacheDir: string;
  cacheMaxBytes: number;
  historyMaxItems: number;
  searchResultCount: number;
  maxTrackDurationSec: number | null;
  ytProxy: string | null;
  ytCookiesFile: string | null;
  poTokenProviderUrl: string | null;
  sponsorblockRemove: string | null;
  playerClients: string;
  ytdlpTimeoutMs: number;
}

export interface BotConfig {
  discordToken: string;
  commandPrefix: string;
  idleTimeoutMs: number;
  prefetchDepth: number;
  maxConcurrentDownloads: number;
  adminUserIds: string[];
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
