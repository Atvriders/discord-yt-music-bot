export enum YtErrorKind {
  Private = "private",
  AgeRestricted = "age_restricted",
  Unavailable = "unavailable",
  MembersOnly = "members_only",
  GeoBlocked = "geo_blocked",
  Live = "live",
  IpBlocked = "ip_blocked",
  PoTokenSabr = "po_token_sabr",
  RateLimited = "rate_limited",
  Timeout = "timeout",
  TooLong = "too_long",
  Unknown = "unknown",
}

export class YtError extends Error {
  constructor(
    public readonly kind: YtErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "YtError";
  }
}

// Ordered most-specific / highest-priority first.
const RULES: ReadonlyArray<[YtErrorKind, RegExp]> = [
  [YtErrorKind.IpBlocked, /not a bot|ip is likely being blocked/i],
  [
    YtErrorKind.PoTokenSabr,
    /po token|only images are available|nsig extraction failed|require a gvs/i,
  ],
  [YtErrorKind.MembersOnly, /members-only|channel'?s members|requires payment/i],
  [YtErrorKind.AgeRestricted, /confirm your age|age-restricted|inappropriate/i],
  [YtErrorKind.Private, /private video|this video is private/i],
  [YtErrorKind.GeoBlocked, /available in your country/i],
  [YtErrorKind.RateLimited, /rate-limited by youtube|ratelimit exceeded/i],
  [YtErrorKind.Unavailable, /video unavailable|has been removed|no longer available/i],
];

export function classifyYtdlpError(stderr: string, code: number | null): YtError {
  for (const [kind, re] of RULES) {
    if (re.test(stderr)) {
      return new YtError(kind, `yt-dlp failed (${kind}): ${stderr.trim().slice(0, 500)}`);
    }
  }
  return new YtError(
    YtErrorKind.Unknown,
    `yt-dlp failed (exit ${code ?? "null"}): ${stderr.trim().slice(0, 500)}`,
  );
}
