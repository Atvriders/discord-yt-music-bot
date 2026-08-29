export interface MediaConfig {
  cacheDir: string;
  cacheMaxBytes: number;
  historyMaxItems: number;
  searchResultCount: number;
  maxTrackDurationSec: number | null;
  normalizeLoudness: boolean;
  ytProxy: string | null;
  /** Path to a mounted cookies.txt (yt-dlp --cookies). Takes precedence over ytCookiesText. */
  ytCookiesFile: string | null;
  /** Inline Netscape cookies.txt CONTENT; materialized to a file at startup (see materializeCookies). */
  ytCookiesText: string | null;
  /**
   * COOKIE_BROWSER_PROFILE — the chromium sidecar's user-data-dir, mounted read-only into this
   * container. It is the only source of the HttpOnly Google auth cookies (SID, HSID,
   * __Secure-1PSID) that no page script and no `document.cookie` copy-paste can reach, so the
   * cookie console's "Import from browser" button is off without it. null = paste-only console.
   */
  cookieBrowserProfile: string | null;
  poTokenProviderUrl: string | null;
  sponsorblockRemove: string | null;
  playerClients: string;
  ytdlpTimeoutMs: number;
  /**
   * Opus encode bitrate (kbps) for every RE-ENCODE path: the ffmpeg transcode (seek / filters /
   * non-opus files), the inline-volume PCM encoder, and yt-dlp's SponsorBlock/extract-audio
   * conversion. The Opus-passthrough fast path is unaffected (source plays untouched).
   */
  audioBitrateKbps: number;
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
  /**
   * COOKIE_ADMIN_PASSWORD — the cookie console's OWN credential, required on every /api/cookies
   * request on top of the ordinary Discord session.
   *
   * The panel is internet-facing and ANY Discord user who shares a guild with the bot can sign in
   * to it. That is the right bar for pause/skip/queue and completely the wrong bar for a console
   * that can overwrite the operator's signed-in Google session. null/empty = the console is OFF
   * (every route 404s and the UI never appears), which is the safe default: an operator who never
   * configured it cannot be surprised by it being reachable.
   */
  cookieAdminPassword: string | null;
}
