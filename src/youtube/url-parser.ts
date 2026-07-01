export type ParsedInput =
  | { kind: "video"; videoId: string }
  | { kind: "query"; query: string }
  // A direct non-YouTube media URL yt-dlp can resolve/download as-is (currently SoundCloud).
  | { kind: "url"; url: string; source: "soundcloud" }
  // A Spotify TRACK link — resolved to title/artist, then matched to a YouTube video to play.
  | { kind: "spotify"; url: string }
  | { kind: "reject"; reason: string };

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = new Set(["shorts", "embed", "live", "v"]);

/** Spotify track ids are base62; a track link is /track/<id> (possibly after an /intl-xx locale). */
const SPOTIFY_TRACK = /(?:^|\/)track\/([A-Za-z0-9]+)/;

function isSoundcloudHost(host: string): boolean {
  return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
}
function isSpotifyHost(host: string): boolean {
  return host === "spotify.com" || host.endsWith(".spotify.com");
}

export function parseInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) return { kind: "reject", reason: "empty input" };

  // The Spotify URI form ("spotify:track:ID") isn't a URL — normalize it to the web link.
  const uri = input.match(/^spotify:track:([A-Za-z0-9]+)$/i);
  if (uri) return { kind: "spotify", url: `https://open.spotify.com/track/${uri[1]}` };

  const hasScheme = /^https?:\/\//i.test(input);
  const looksLikeUrl = hasScheme || /^[\w-]+(\.[\w-]+)+\//.test(input);
  if (!looksLikeUrl) return { kind: "query", query: input };

  let url: URL;
  try {
    url = new URL(hasScheme ? input : `https://${input}`);
  } catch {
    return { kind: "query", query: input };
  }

  const host = url.hostname.toLowerCase();

  // The protocol-less heuristic also fires on legitimate `word.tld/path` search queries
  // (e.g. "fly.me/to/the/moon", "death.grips/get.got"). When there is no explicit scheme
  // and the inferred host is not a RECOGNIZED media host, treat the input as a search query
  // rather than rejecting it. Inputs that carry an explicit http(s):// scheme but point at
  // an unrecognized host still fall through to the reject branch below.
  const recognized =
    host === "youtu.be" || YT_HOSTS.has(host) || isSoundcloudHost(host) || isSpotifyHost(host);
  if (!hasScheme && !recognized) {
    return { kind: "query", query: input };
  }

  if (isSpotifyHost(host)) {
    const m = url.pathname.match(SPOTIFY_TRACK);
    if (m) return { kind: "spotify", url: `https://open.spotify.com/track/${m[1]}` };
    return {
      kind: "reject",
      reason:
        "only Spotify track links are supported (not albums/playlists) — open a song and copy its link",
    };
  }

  if (isSoundcloudHost(host)) {
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs.includes("sets")) {
      return {
        kind: "reject",
        reason: "SoundCloud sets/playlists aren't supported — link a single track",
      };
    }
    // Hand the whole URL to yt-dlp: it resolves both full user/track links and short
    // on.soundcloud.com redirects. resolveUrl rejects a profile/set that isn't a single track.
    return { kind: "url", url: url.toString(), source: "soundcloud" };
  }

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return VIDEO_ID.test(id)
      ? { kind: "video", videoId: id }
      : { kind: "reject", reason: "invalid youtu.be video id" };
  }

  if (YT_HOSTS.has(host)) {
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID.test(v)) return { kind: "video", videoId: v };

    const segs = url.pathname.split("/").filter(Boolean);
    const prefix = segs[0];
    const candidate = segs[1];
    if (prefix && candidate && PATH_PREFIXES.has(prefix) && VIDEO_ID.test(candidate)) {
      return { kind: "video", videoId: candidate };
    }

    if (url.searchParams.get("list")) {
      return { kind: "reject", reason: "playlist URLs are not supported — link a single video" };
    }
    return { kind: "reject", reason: "could not find a video id in the YouTube URL" };
  }

  return { kind: "reject", reason: "only YouTube, SoundCloud, or Spotify links are accepted" };
}
