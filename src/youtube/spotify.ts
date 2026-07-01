/**
 * Spotify → YouTube bridge. Spotify audio is DRM-protected and can't be played directly, so
 * a Spotify TRACK link is resolved to a "<track> <artist>" search string here; the caller
 * then searches YouTube and plays the top match. No Spotify API credentials are required —
 * we read the public track page's Open Graph / <title> metadata (with an oEmbed fallback).
 *
 * Everything is best-effort: any network error, a stripped-down response, or an
 * unparseable page resolves to `null` so the caller can surface a clean "couldn't resolve"
 * message instead of throwing.
 */

/**
 * Spotify serves a client-rendered (JS) shell with NO Open Graph tags to ordinary browser
 * UAs, and only SERVER-renders the og:title / og:description / <title> metadata for
 * recognized link-preview crawlers (facebookexternalhit, Twitterbot, Discordbot). We ARE a
 * Discord bot, so a Discordbot UA is both honest and gets us the metadata-bearing HTML.
 * (A desktop Chrome UA returns zero OG tags — it would silently defeat extractSpotifyQuery.)
 */
export const SPOTIFY_UA = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discord.com)";

/** Per-request timeout so a hung upstream can never wedge the resolve path. */
const REQUEST_TIMEOUT_MS = 6000;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Decode the handful of HTML entities that show up in Spotify titles (incl. numeric forms). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&[a-z0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/** Collapse whitespace, drop a trailing "| Spotify", and trim. */
function clean(s: string): string {
  return s
    .replace(/\s*\|\s*Spotify\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read a `<meta property|name="<prop>" content="…">` value, tolerating either attribute
 * order (some renderers emit content before property). Returns the decoded content or null.
 */
function metaContent(html: string, prop: string): string | null {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pf = `(?:property|name)=["']${p}["']`;
  // Four alternatives: property-first OR content-first, with a double- OR single-quoted
  // content value. Using `[^"]*` / `[^']*` (not `.*?`) means a value keeps an apostrophe
  // inside a "…" (or a quote inside a '…'), and a match can never span across adjacent
  // <meta> tags — so reversed attribute order resolves to the correct tag.
  const re = new RegExp(
    `<meta[^>]+${pf}[^>]*content="([^"]*)"` +
      `|<meta[^>]+${pf}[^>]*content='([^']*)'` +
      `|<meta[^>]+content="([^"]*)"[^>]*${pf}` +
      `|<meta[^>]+content='([^']*)'[^>]*${pf}`,
    "i",
  );
  const m = html.match(re);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : undefined;
  const val = raw ? decodeEntities(raw).trim() : "";
  return val || null;
}

/**
 * Parse the `<title>` tag. Spotify track pages read
 *   "<track> - song and lyrics by <artist> | Spotify"  (or "… - song by <artist> | Spotify"),
 * which yields BOTH fields reliably. If that shape isn't present, return the whole title (sans
 * "| Spotify") as the track with no artist.
 */
function fromTitleTag(html: string): { track: string | null; artist: string | null } {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!m || !m[1]) return { track: null, artist: null };
  const raw = decodeEntities(m[1]).trim();
  const by = raw.match(
    /^(.*?)\s+[-–—]\s+song(?:\s+and\s+lyrics)?\s+by\s+(.+?)\s*(?:\|\s*Spotify\s*)?$/i,
  );
  if (by) return { track: (by[1] ?? "").trim() || null, artist: (by[2] ?? "").trim() || null };
  return { track: clean(raw) || null, artist: null };
}

/**
 * Best-effort artist from the middot/bullet-separated og:description. Spotify's current form
 * is 4-part — "Artist · Album · Song · Year" — but older/edge forms vary, so rather than
 * trust a fixed position we take the FIRST segment that isn't obvious noise: a generic label
 * ("Song"/"Album"/…), a bare year, or a "Listen to … on Spotify" preamble. This is only a
 * FALLBACK; extractSpotifyQuery prefers the reliable "<title> … by ARTIST" capture.
 */
function artistFromDescription(html: string): string | null {
  const d = metaContent(html, "og:description") ?? metaContent(html, "description");
  if (!d) return null;
  const isNoise = (s: string): boolean =>
    /^(song|single|album|ep|playlist|podcast|episode)$/i.test(s) ||
    /^\d{4}$/.test(s) || // a bare year is never the artist
    /\bon Spotify\b/i.test(s); // a "Listen to … on Spotify" preamble segment
  const parts = d
    .split(/\s*[·•]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts.find((s) => !isNoise(s)) ?? null;
}

/**
 * Extract a "<track> <artist>" (or just "<track>") YouTube search string from a Spotify
 * track page's HTML. Pure and deterministic — the network fetch lives in resolveSpotifyQuery.
 * Returns null when no track name can be found at all.
 */
export function extractSpotifyQuery(html: string): string | null {
  const tag = fromTitleTag(html);
  const track = clean(metaContent(html, "og:title") ?? tag.track ?? "");
  const artist = clean(tag.artist ?? artistFromDescription(html) ?? "");
  if (track && artist) return `${track} ${artist}`;
  return track || null;
}

/** The subset of `fetch` we use — always called with a string URL. Global `fetch` satisfies it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SpotifyDeps {
  /** Injectable fetch (defaults to global fetch) — lets tests feed fixture responses. */
  fetchImpl?: FetchLike;
}

async function fetchText(
  url: string,
  doFetch: FetchLike,
  headers: Record<string, string>,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers, redirect: "follow" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, doFetch: FetchLike): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a Spotify track URL to a YouTube search string. Tries the track page HTML first
 * (gives track + artist), then falls back to the key-less oEmbed endpoint (track title only).
 * Best-effort: resolves to null on any failure so the caller shows a clean message.
 */
export async function resolveSpotifyQuery(
  url: string,
  deps: SpotifyDeps = {},
): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;

  const html = await fetchText(url, doFetch, {
    "user-agent": SPOTIFY_UA,
    "accept-language": "en",
  });
  if (html) {
    const q = extractSpotifyQuery(html);
    if (q) return q;
  }

  // oEmbed fallback (https://open.spotify.com/oembed?url=…) → { title } (the track name).
  const oembed = await fetchJson(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
    doFetch,
  );
  const title =
    oembed && typeof (oembed as { title?: unknown }).title === "string"
      ? clean((oembed as { title: string }).title)
      : "";
  return title || null;
}
