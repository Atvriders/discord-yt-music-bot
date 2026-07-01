import { describe, it, expect, vi } from "vitest";
import { decodeEntities, extractSpotifyQuery, resolveSpotifyQuery } from "./spotify.js";

describe("decodeEntities", () => {
  it("decodes named and numeric HTML entities", () => {
    expect(decodeEntities("Guns &amp; Roses")).toBe("Guns & Roses");
    expect(decodeEntities("&#39;Heroes&#39;")).toBe("'Heroes'");
    expect(decodeEntities("&#x27;x&#x27;")).toBe("'x'");
    expect(decodeEntities("a &lt;b&gt; &quot;c&quot;")).toBe('a <b> "c"');
  });
  it("leaves unknown entities untouched", () => {
    expect(decodeEntities("100&percnt; &unknownentity;")).toBe("100&percnt; &unknownentity;");
  });
});

describe("extractSpotifyQuery", () => {
  it("reads track + artist from the <title> 'song and lyrics by' form", () => {
    const html = `<html><head><title>Blinding Lights - song and lyrics by The Weeknd | Spotify</title></head></html>`;
    expect(extractSpotifyQuery(html)).toBe("Blinding Lights The Weeknd");
  });

  it("reads the shorter '<track> - song by <artist>' <title> form", () => {
    const html = `<title>Come Together - song by The Beatles | Spotify</title>`;
    expect(extractSpotifyQuery(html)).toBe("Come Together The Beatles");
  });

  it("prefers og:title for the track and derives the artist from og:description", () => {
    const html = `
      <meta property="og:title" content="Bohemian Rhapsody" />
      <meta property="og:description" content="Queen · Song · 1975" />
      <title>Bohemian Rhapsody | Spotify</title>`;
    expect(extractSpotifyQuery(html)).toBe("Bohemian Rhapsody Queen");
  });

  it("tolerates reversed meta attribute order (content before property)", () => {
    const html = `<meta content="Levitating" property="og:title"><meta content="Dua Lipa · Song · 2020" property="og:description">`;
    expect(extractSpotifyQuery(html)).toBe("Levitating Dua Lipa");
  });

  it("decodes entities in the extracted fields", () => {
    const html = `<title>AT&amp;T Jam - song by Guns &amp; Roses | Spotify</title>`;
    expect(extractSpotifyQuery(html)).toBe("AT&T Jam Guns & Roses");
  });

  it("derives the artist from the 4-part 'Artist · Album · Song · Year' description", () => {
    const html = `
      <meta property="og:title" content="Blinding Lights" />
      <meta property="og:description" content="The Weeknd · After Hours · Song · 2020" />`;
    expect(extractSpotifyQuery(html)).toBe("Blinding Lights The Weeknd");
  });

  it("never treats a bare year segment as the artist", () => {
    // og:title carries the track; og:description is only "Song · 2002" (no artist) → no artist,
    // and crucially NOT the year.
    const html = `
      <meta property="og:title" content="Clocks" />
      <meta property="og:description" content="Song · 2002" />`;
    expect(extractSpotifyQuery(html)).toBe("Clocks");
  });

  it("skips a 'Listen to … on Spotify' preamble segment when finding the artist", () => {
    const html = `
      <meta property="og:title" content="Yellow" />
      <meta property="og:description" content="Listen to Yellow on Spotify · Coldplay · Song · 2000" />`;
    expect(extractSpotifyQuery(html)).toBe("Yellow Coldplay");
  });

  it("does not truncate a value at an apostrophe inside a double-quoted attribute", () => {
    const html = `
      <meta property="og:title" content="Don't Stop Me Now" />
      <meta property="og:description" content="Queen · Jazz · Song · 1978" />`;
    expect(extractSpotifyQuery(html)).toBe("Don't Stop Me Now Queen");
  });

  it("returns just the track when no artist can be found", () => {
    const html = `<meta property="og:title" content="Untitled Instrumental">`;
    expect(extractSpotifyQuery(html)).toBe("Untitled Instrumental");
  });

  it("returns null when there is no usable metadata", () => {
    expect(extractSpotifyQuery("<html><head></head><body>nope</body></html>")).toBeNull();
  });
});

/** Build a minimal fetch-Response stand-in for the injected fetch. */
function res(body: string, { ok = true, json }: { ok?: boolean; json?: unknown } = {}) {
  return {
    ok,
    text: async () => body,
    json: async () => json ?? JSON.parse(body),
  } as unknown as Response;
}

describe("resolveSpotifyQuery", () => {
  const URL = "https://open.spotify.com/track/abc";

  it("resolves via the track-page HTML", async () => {
    const fetchImpl = vi.fn(async () =>
      res(`<title>Feel Good Inc - song by Gorillaz | Spotify</title>`),
    );
    await expect(resolveSpotifyQuery(URL, { fetchImpl })).resolves.toBe("Feel Good Inc Gorillaz");
  });

  it("falls back to oEmbed (title only) when the HTML has no usable metadata", async () => {
    const fetchImpl = vi.fn(async (u: string) => {
      if (u.includes("oembed")) return res("", { json: { title: "Midnight City" } });
      return res("<html><head></head></html>"); // no metadata
    });
    await expect(resolveSpotifyQuery(URL, { fetchImpl })).resolves.toBe("Midnight City");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to oEmbed when the page fetch throws", async () => {
    const fetchImpl = vi.fn(async (u: string) => {
      if (u.includes("oembed")) return res("", { json: { title: "Teardrop" } });
      throw new Error("network down");
    });
    await expect(resolveSpotifyQuery(URL, { fetchImpl })).resolves.toBe("Teardrop");
  });

  it("resolves to null when both the page and oEmbed fail", async () => {
    const fetchImpl = vi.fn(async () => res("", { ok: false }));
    await expect(resolveSpotifyQuery(URL, { fetchImpl })).resolves.toBeNull();
  });
});
