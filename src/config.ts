import type { MediaConfig, BotConfig } from "./types/config-types.js";

export type { MediaConfig, BotConfig } from "./types/config-types.js";

type Env = Record<string, string | undefined>;

function intEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid ${key}: expected an integer, got "${raw}"`);
  }
  return n;
}

function strEnv(env: Env, key: string): string | null {
  const raw = env[key];
  return raw === undefined || raw === "" ? null : raw;
}

export function loadMediaConfig(env: Env = process.env): MediaConfig {
  const maxDur = strEnv(env, "MAX_TRACK_DURATION_SEC");
  return {
    cacheDir: strEnv(env, "CACHE_DIR") ?? "/data/cache",
    cacheMaxBytes: intEnv(env, "CACHE_MAX_MB", 2048) * 1024 * 1024,
    historyMaxItems: intEnv(env, "HISTORY_MAX_ITEMS", 100),
    searchResultCount: intEnv(env, "SEARCH_RESULT_COUNT", 5),
    maxTrackDurationSec: maxDur === null ? null : intEnv(env, "MAX_TRACK_DURATION_SEC", 0),
    ytProxy: strEnv(env, "YT_PROXY"),
    ytCookiesFile: strEnv(env, "YT_COOKIES"),
    poTokenProviderUrl: strEnv(env, "PO_TOKEN_PROVIDER_URL"),
    sponsorblockRemove: strEnv(env, "SPONSORBLOCK_REMOVE"),
    playerClients: strEnv(env, "YT_PLAYER_CLIENTS") ?? "android_vr,web_embedded,tv",
    ytdlpTimeoutMs: intEnv(env, "YTDLP_TIMEOUT_MS", 60_000),
  };
}

const SNOWFLAKE = /^\d{17,20}$/;

export function loadBotConfig(env: Env = process.env): BotConfig {
  const token = strEnv(env, "DISCORD_TOKEN");
  if (token === null) throw new Error("DISCORD_TOKEN is required");
  return {
    discordToken: token,
    commandPrefix: strEnv(env, "COMMAND_PREFIX") ?? "?",
    idleTimeoutMs: intEnv(env, "IDLE_TIMEOUT_SEC", 300) * 1000,
    prefetchDepth: intEnv(env, "PREFETCH_DEPTH", 1),
    maxConcurrentDownloads: intEnv(env, "MAX_TRANSCODE_JOBS", 2),
    adminUserIds: (strEnv(env, "ADMIN_USER_IDS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => SNOWFLAKE.test(s)),
  };
}
