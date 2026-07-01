import type { MediaConfig, BotConfig, BotInstance, WebConfig } from "./types/config-types.js";
import { parseAdminIds } from "./auth/authz.js";
import { LEVELS, isValidLevel } from "./util/logger.js";

export type { MediaConfig, BotConfig, BotInstance, WebConfig } from "./types/config-types.js";

type Env = Record<string, string | undefined>;

function intEnv(
  env: Env,
  key: string,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid ${key}: expected an integer, got "${raw}"`);
  }
  if (opts?.min !== undefined && n < opts.min) {
    throw new Error(`Invalid ${key}: expected >= ${opts.min}, got "${raw}"`);
  }
  if (opts?.max !== undefined && n > opts.max) {
    throw new Error(`Invalid ${key}: expected <= ${opts.max}, got "${raw}"`);
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
    cacheMaxBytes: intEnv(env, "CACHE_MAX_MB", 2048, { min: 1 }) * 1024 * 1024,
    historyMaxItems: intEnv(env, "HISTORY_MAX_ITEMS", 100, { min: 1 }),
    searchResultCount: intEnv(env, "SEARCH_RESULT_COUNT", 5, { min: 1 }),
    // 0 (or negative) means "no ceiling", matching the null-handling convention used
    // throughout the codebase. A bare 0 would otherwise reject EVERY positive-duration
    // track in the youtube guard, silently breaking all playback.
    maxTrackDurationSec:
      maxDur === null ? null : intEnv(env, "MAX_TRACK_DURATION_SEC", 0, { min: 0 }) || null,
    // Seeds the INITIAL per-guild "normalize loudness" toggle (the panel overrides per guild).
    normalizeLoudness: strEnv(env, "NORMALIZE_LOUDNESS") === "true",
    ytProxy: strEnv(env, "YT_PROXY"),
    ytCookiesFile: strEnv(env, "YT_COOKIES"),
    poTokenProviderUrl: strEnv(env, "PO_TOKEN_PROVIDER_URL"),
    sponsorblockRemove: strEnv(env, "SPONSORBLOCK_REMOVE"),
    playerClients: strEnv(env, "YT_PLAYER_CLIENTS") ?? "android_vr,web_embedded,tv",
    ytdlpTimeoutMs: intEnv(env, "YTDLP_TIMEOUT_MS", 60_000, { min: 1 }),
  };
}

/**
 * Parse the LIST of bots from env. Bot 1 keeps the historical unnumbered env names so a
 * single-bot deploy is 100% backward-compatible; bots 2,3,... use the DISCORD_TOKEN_<i> /
 * COMMAND_PREFIX_<i> / BOT_NAME_<i> family. Parsing walks i upward from 2 and STOPS at the
 * first gap (an unset/empty DISCORD_TOKEN_<i>), so the list is always a contiguous prefix —
 * DISCORD_TOKEN_3 with no DISCORD_TOKEN_2 is treated as "only bot 1", never a sparse list.
 */
// Default command prefixes for bots 2,3,… — DISTINCT SINGLE CHARACTERS that are not prefixes
// of one another (bot 1 uses "?"). This matters: with "?" and "?2", the message "?2play" also
// starts with "?", so bot 1's parser would grab it (its bare "?<query>" fallback). Non-overlapping
// single-char prefixes avoid that entirely. Beyond this list, the operator must set the prefix
// explicitly (the prefix-free validation below will flag a bad fallback).
const DEFAULT_PREFIXES = ["?", "!", "$", "%", "&", "+", "=", "~"] as const;

function loadBotInstances(env: Env): BotInstance[] {
  const token1 = strEnv(env, "DISCORD_TOKEN");
  if (token1 === null) throw new Error("DISCORD_TOKEN is required");
  const bots: BotInstance[] = [
    {
      id: "1",
      token: token1,
      commandPrefix: strEnv(env, "COMMAND_PREFIX") ?? "?",
      name: strEnv(env, "BOT_NAME") ?? "YouTube Music Bot",
    },
  ];
  for (let i = 2; ; i++) {
    const token = strEnv(env, `DISCORD_TOKEN_${i}`);
    if (token === null) break; // contiguous-only: first gap ends the list
    bots.push({
      id: String(i),
      token,
      commandPrefix: strEnv(env, `COMMAND_PREFIX_${i}`) ?? DEFAULT_PREFIXES[i - 1] ?? `?${i}`,
      name: strEnv(env, `BOT_NAME_${i}`) ?? `YouTube Music Bot ${i}`,
    });
  }
  // Command prefixes must be PREFIX-FREE — not merely distinct, but none a prefix of another.
  // With "?" and "?2", "?2play" also starts with "?", so bot 1 would grab bot 2's command (the
  // parser's bare "?<query>" fallback). Reject any such overlap (which also catches exact dupes).
  for (let a = 0; a < bots.length; a++) {
    for (let b = a + 1; b < bots.length; b++) {
      const pa = bots[a]!.commandPrefix;
      const pb = bots[b]!.commandPrefix;
      if (pa.startsWith(pb) || pb.startsWith(pa)) {
        throw new Error(
          `Command prefixes for bots ${bots[a]!.id} ("${pa}") and ${bots[b]!.id} ("${pb}") overlap — ` +
            `one is a prefix of the other, so "${pa.length <= pb.length ? pb : pa}…" commands would be ambiguous. ` +
            `Use distinct, non-overlapping prefixes (e.g. "?", "!", "$").`,
        );
      }
    }
  }
  return bots;
}

export function loadBotConfig(env: Env = process.env): BotConfig {
  return {
    bots: loadBotInstances(env),
    idleTimeoutMs: intEnv(env, "IDLE_TIMEOUT_SEC", 300, { min: 1 }) * 1000,
    prefetchDepth: intEnv(env, "PREFETCH_DEPTH", 1, { min: 0 }),
    // Must be >= 1: a Semaphore(0) deadlocks (no download ever acquires a slot).
    maxConcurrentDownloads: intEnv(env, "MAX_TRANSCODE_JOBS", 2, { min: 1 }),
    // Single source of truth: parseAdminIds (auth/authz.ts) owns the snowflake format and
    // split/trim/filter pipeline. BotConfig.adminUserIds is a string[]; index.ts wraps it in
    // a Set, so spread the parsed Set back to an array here.
    adminUserIds: [...parseAdminIds(env)],
    logLevel: parseLogLevel(strEnv(env, "LOG_LEVEL")),
  };
}

/**
 * Validate LOG_LEVEL against the SAME level set the logger uses (imported, never duplicated)
 * and fail fast on an unrecognized value — consistent with how intEnv/PORT/SESSION_SECRET
 * reject bad config in this file. Without this, a typo (LOG_LEVEL=verbose) was silently
 * demoted to "info" by createLogger with no signal to the operator. Case is normalized so a
 * valid level in any case (e.g. "WARN" from docker-compose/CI) is accepted, not rejected.
 */
function parseLogLevel(raw: string | null): string {
  if (raw === null) return "info";
  if (!isValidLevel(raw)) {
    throw new Error(`Invalid LOG_LEVEL: got "${raw}" (expected one of ${LEVELS.join(", ")})`);
  }
  return raw.toLowerCase();
}

export function loadWebConfig(env: Env = process.env): WebConfig {
  const clientId = strEnv(env, "DISCORD_CLIENT_ID");
  const clientSecret = strEnv(env, "DISCORD_CLIENT_SECRET");
  const publicBaseUrlRaw = strEnv(env, "PUBLIC_BASE_URL");
  const sessionSecret = strEnv(env, "SESSION_SECRET");
  if (!clientId) throw new Error("DISCORD_CLIENT_ID is required");
  if (!clientSecret) throw new Error("DISCORD_CLIENT_SECRET is required");
  if (!publicBaseUrlRaw) throw new Error("PUBLIC_BASE_URL is required");
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET is required and must be at least 32 characters");
  }
  const publicBaseUrl = publicBaseUrlRaw.replace(/\/$/, "");
  const nodeEnv = strEnv(env, "NODE_ENV") ?? "development";
  return {
    clientId,
    clientSecret,
    publicBaseUrl,
    redirectUri: strEnv(env, "OAUTH_REDIRECT_URI") ?? `${publicBaseUrl}/auth/callback`,
    sessionSecret,
    port: intEnv(env, "PORT", 8080, { min: 1, max: 65535 }),
    host: strEnv(env, "HOST") ?? "0.0.0.0",
    // Opt-in: only trust X-Forwarded-For when explicitly enabled behind a trusted reverse
    // proxy. Defaulting to true let unauthenticated clients spoof XFF and mint unlimited
    // rate-limit buckets (the keyGenerator falls back to req.ip).
    trustProxy: strEnv(env, "TRUST_PROXY") === "true",
    allowedWsOrigins: (strEnv(env, "ALLOWED_WS_ORIGINS") ?? publicBaseUrl)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    nodeEnv,
    secureCookies: nodeEnv === "production",
  };
}
