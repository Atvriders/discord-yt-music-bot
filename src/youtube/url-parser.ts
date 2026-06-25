export type ParsedInput =
  | { kind: "video"; videoId: string }
  | { kind: "query"; query: string }
  | { kind: "reject"; reason: string };

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = new Set(["shorts", "embed", "live", "v"]);

export function parseInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) return { kind: "reject", reason: "empty input" };

  const looksLikeUrl = /^https?:\/\//i.test(input) || /^[\w-]+(\.[\w-]+)+\//.test(input);
  if (!looksLikeUrl) return { kind: "query", query: input };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { kind: "query", query: input };
  }

  const host = url.hostname.toLowerCase();

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

  return { kind: "reject", reason: "only YouTube links are accepted" };
}
