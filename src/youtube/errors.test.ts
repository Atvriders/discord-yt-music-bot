import { describe, it, expect } from "vitest";
import { classifyYtdlpError, isRetryableAcrossClients, YtError, YtErrorKind } from "./errors.js";

describe("classifyYtdlpError", () => {
  it.each<[string, YtErrorKind]>([
    [
      "ERROR: [youtube] xx: Private video. Sign in if you've been granted access",
      YtErrorKind.Private,
    ],
    [
      "ERROR: Sign in to confirm your age. This video may be inappropriate",
      YtErrorKind.AgeRestricted,
    ],
    [
      "ERROR: [youtube] xx: Video unavailable. This video has been removed",
      YtErrorKind.Unavailable,
    ],
    ["ERROR: Join this channel to get access to members-only content", YtErrorKind.MembersOnly],
    [
      "ERROR: The uploader has not made this video available in your country",
      YtErrorKind.GeoBlocked,
    ],
    [
      "ERROR: Sign in to confirm you're not a bot. Your IP is likely being blocked",
      YtErrorKind.IpBlocked,
    ],
    [
      "WARNING: Some web client https formats require a GVS PO Token which was not provided",
      YtErrorKind.PoTokenSabr,
    ],
    ["ERROR: Only images are available for download", YtErrorKind.PoTokenSabr],
    [
      "ERROR: This content isn't available, rate-limited by YouTube for up to an hour",
      YtErrorKind.RateLimited,
    ],
    // yt-dlp's plain HTTP-level rate limit (429) must classify as RateLimited too, not Unknown.
    [
      "ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests",
      YtErrorKind.RateLimited,
    ],
    ["ERROR: Too many requests, please try again later", YtErrorKind.RateLimited],
  ])("classifies %s", (stderr, kind) => {
    expect(classifyYtdlpError(stderr, 1).kind).toBe(kind);
  });

  it("prioritizes IP-block over a generic private hint", () => {
    const stderr =
      "Private video. Sign in to confirm you're not a bot. Your IP is likely being blocked";
    expect(classifyYtdlpError(stderr, 1).kind).toBe(YtErrorKind.IpBlocked);
  });

  it("falls back to Unknown and keeps the raw stderr in the message", () => {
    const e = classifyYtdlpError("ERROR: something totally new", 1);
    expect(e.kind).toBe(YtErrorKind.Unknown);
    expect(e.message).toContain("something totally new");
  });
});

describe("isRetryableAcrossClients", () => {
  it.each([
    YtErrorKind.Private,
    YtErrorKind.Unavailable,
    YtErrorKind.MembersOnly,
    YtErrorKind.GeoBlocked,
    YtErrorKind.Live,
    YtErrorKind.TooLong,
  ])("treats %s as terminal (no client swap helps)", (kind) => {
    expect(isRetryableAcrossClients(new YtError(kind, "x"))).toBe(false);
  });

  it.each([
    YtErrorKind.PoTokenSabr,
    YtErrorKind.IpBlocked,
    YtErrorKind.RateLimited,
    YtErrorKind.Timeout,
    YtErrorKind.Unknown,
    YtErrorKind.AgeRestricted, // several clients bypass age-gates the default client trips on
  ])("treats %s as retryable on another client", (kind) => {
    expect(isRetryableAcrossClients(new YtError(kind, "x"))).toBe(true);
  });

  it("retries on a non-YtError (transport / spawn failure)", () => {
    expect(isRetryableAcrossClients(new Error("spawn ENOENT"))).toBe(true);
  });
});

describe("cookies_invalid — a jar yt-dlp cannot parse is not a YouTube verdict", () => {
  // Given an unparseable --cookies file yt-dlp aborts before contacting YouTube, so EVERY call
  // fails identically. Classified as Unknown it was retryable, so the ladder burned through
  // every player_client and still reported the useless "unknown" to the operator.
  const MESSAGES = [
    "ERROR: '/data/cache/yt-cookies.txt' does not look like a Netscape format cookies file",
    "ERROR: Unable to load cookies: invalid Netscape format cookies file",
    "ERROR: unable to open cookies file",
    "ERROR: failed to parse cookies",
  ];

  it("classifies every spelling yt-dlp uses", () => {
    for (const stderr of MESSAGES) {
      expect(classifyYtdlpError(stderr, 1).kind).toBe(YtErrorKind.CookiesInvalid);
    }
  });

  it("is TERMINAL — no player_client swap can fix a broken file", () => {
    expect(isRetryableAcrossClients(classifyYtdlpError(MESSAGES[0]!, 1))).toBe(false);
  });

  it("wins over the other rules, since it fires before YouTube is even reached", () => {
    // A cookie-load abort can carry incidental text that trips a looser rule; the file is still
    // the thing to fix.
    const stderr =
      "ERROR: does not look like a Netscape format cookies file (sign in to confirm you're not a bot)";
    expect(classifyYtdlpError(stderr, 1).kind).toBe(YtErrorKind.CookiesInvalid);
  });

  it("does not fire on an ordinary extraction failure that merely says 'cookies'", () => {
    const stderr =
      "ERROR: Sign in to confirm you're not a bot. Use --cookies for the authentication.";
    expect(classifyYtdlpError(stderr, 1).kind).toBe(YtErrorKind.IpBlocked);
  });
});
