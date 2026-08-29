import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { toNetscapeCookies } from "../config.js";
import { runYtDlp, type YtDlpRun } from "../youtube/ytdlp.js";
import { YtError, YtErrorKind, classifyYtdlpError } from "../youtube/errors.js";
import { setCookiesFile, type YouTubeService } from "../youtube/index.js";
import { getRootLogger } from "../util/logger.js";
import { Mutex } from "../util/mutex.js";

/**
 * The cookie console — everything the operator needs to keep the bot's YouTube session alive
 * WITHOUT editing docker-compose and redeploying.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: a cookie VALUE never leaves this file. Not in a
 * return value, not in an error, not in a log line. The control panel is internet-facing and any
 * Discord user who shares a guild with the bot can sign in to it, while the jar holds a
 * logged-in Google session — so echoing even one cookie hands over the account. Every reason
 * string below is a literal WE wrote; the only external text that ever reaches a caller is a
 * `YtErrorKind` enum value (`ip_blocked`, `timeout`, …), never `err.message` — which embeds the
 * raw yt-dlp stderr slice — and never the jar's contents.
 *
 * Two ways in, one jar out:
 *  - `saveFromText()`  — the operator pastes an export or a DevTools `Cookie:` header.
 *  - `importFromBrowser()` — yt-dlp lifts the live session out of the LAN-only chromium
 *    sidecar's profile, which is the only source of the HttpOnly auth cookies (SID, HSID,
 *    __Secure-1PSID) that no page script can read.
 * Both end the same way: write the jar 0600, hot-apply it to the running YouTubeService (no
 * restart), then PROVE it with a real extraction, so the UI can distinguish "saved and working"
 * from "saved but YouTube still refuses".
 *
 * One console for the whole process, not one per bot: every bot in the multi-bot registry shares
 * a single YouTubeService and therefore a single jar.
 *
 * NOTHING here throws. Every method resolves with a `CookieResult`; a broken disk, a missing
 * sidecar or a dead yt-dlp is a reason string, never an exception out of a route handler.
 */

/** Where the jar lives inside CACHE_DIR. Must match the filename `materializeCookies()` uses. */
export const COOKIE_JAR_FILE = "yt-cookies.txt";

/** Canonical jar path for a cache dir — wiring passes this as `jarPath`. */
export function defaultJarPath(cacheDir: string): string {
  return join(cacheDir, COOKIE_JAR_FILE);
}

/**
 * "Me at the zoo" — the oldest video on YouTube: public everywhere, 19 seconds long, and about
 * as unlikely to be deleted as anything on the platform. Short on purpose: `resolve()` also
 * enforces MAX_TRACK_DURATION_SEC, so a long probe video could fail a healthy jar with
 * `too_long` on a deploy configured with a tight ceiling.
 */
export const PROBE_VIDEO_ID = "jNQXAC9IVRw";

/** Where the jar currently in place came from. "env" = compose (YT_COOKIES / YT_COOKIES_TEXT). */
export type CookieSource = "env" | "paste" | "browser" | "none";

export interface CookieHealth {
  configured: boolean; // a cookie jar exists on disk
  source: CookieSource;
  updatedAt: number | null; // epoch ms the jar was last written by US
  lastCheck: { at: number; ok: boolean; reason: string | null } | null;
  browserProfileAvailable: boolean; // the sidecar profile dir is mounted and readable
}

export interface CookieResult {
  ok: boolean;
  reason: string | null;
  /**
   * Set when the operation SUCCEEDED but the operator still needs to know something — a jar that
   * saved fine yet carries no sign-in cookie, an import that silently dropped cookies it could not
   * decrypt. Absent on the ordinary happy path. Like `reason`, it is only ever one of the fixed
   * literals below: no cookie NAME from the jar, and certainly no value, is ever interpolated.
   */
  warning?: string | null;
}

type RunFn = typeof runYtDlp;

export interface CookieServiceDeps {
  /** CACHE_DIR. Created on demand so the very first paste works on a fresh volume. */
  cacheDir: string;
  /**
   * The jar we own and hand to yt-dlp. Pass the EFFECTIVE cookie file (an explicit YT_COOKIES
   * path when the operator mounted one, otherwise `defaultJarPath(cacheDir)`) so the console
   * reports and rewrites the same file the extractor actually reads.
   */
  jarPath: string;
  /** The validation probe: a REAL extraction with whatever jar is live at the time of the call. */
  youtube: Pick<YouTubeService, "resolve">;
  /** COOKIE_BROWSER_PROFILE — the sidecar's chromium profile dir; null disables the import. */
  browserProfile: string | null;
  /** Hot-apply hook. Defaults to the YouTubeService module setter, i.e. no restart. */
  applyCookies?: (path: string | null) => void;
  /** yt-dlp runner (browser import only). Injected so tests never spawn a process. */
  run?: RunFn;
  /** Timeout for the browser-import run. Defaults to the metadata timeout, 60s. */
  ytdlpTimeoutMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Count the cookie LINES in a Netscape jar. Used only to reject an input that carries no
 * cookies at all — the count is a number, never content.
 *
 * A cookie line is 7 TAB-separated fields. Comment lines carry no tabs and so score 1 field —
 * EXCEPT the `#HttpOnly_<domain>` prefix that real browser exports use, which IS a cookie line
 * and is exactly where the auth cookies that matter (SID, HSID, __Secure-1PSID) live. Counting
 * by field width rather than by a leading "#" is what keeps a genuine HttpOnly-only export from
 * being rejected as "no cookies found".
 */
export function countCookieLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    // EXACTLY 7 — a Netscape entry is domain/flag/path/secure/expiry/name/value. Accepting ">= 7"
    // let a malformed paste (an extra tab, a pasted table) count as valid, so the console reported
    // "saved" for a jar yt-dlp then refuses to parse.
    if (line.split("\t").length === 7) n += 1;
  }
  return n;
}

/**
 * The Google/YouTube sign-in cookies. The presence of ANY one of them — with a value — is what
 * makes a jar a SESSION rather than a bag of consent and preference cookies.
 *
 * SID / HSID / SSID / APISID / SAPISID are the classic set, most of them HttpOnly, which is
 * exactly why the browser import exists at all: no page script can read them, so they cannot come
 * from a `document.cookie` copy-paste. `__Secure-1PSID` / `__Secure-3PSID` (and their -APISID
 * partners) are the modern first-/third-party-partitioned equivalents that Google actually issues
 * today, and LOGIN_INFO is YouTube's own. Names only — this set holds no secrets and nothing here
 * ever touches a value.
 */
export const AUTH_COOKIE_NAMES: ReadonlySet<string> = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "LOGIN_INFO",
]);

/**
 * Is this Netscape domain field one of Google's? Two prefixes have to come off first, and both
 * appear on the lines that matter: the leading `.` of a host-wildcard entry, and the `#HttpOnly_`
 * marker a real browser export puts in front of precisely the auth cookies we are looking for
 * (`#HttpOnly_.youtube.com`).
 *
 * Deliberately narrow — google.com and youtube.com and their subdomains, nothing else. A `SID`
 * cookie for some unrelated host is not a YouTube session, and accepting one would let a jar sail
 * past the check that exists to stop a bad import.
 */
function isGoogleDomain(domainField: string): boolean {
  const d = domainField
    .replace(/^#HttpOnly_/, "")
    .replace(/^\./, "")
    .toLowerCase();
  return (
    d === "google.com" ||
    d.endsWith(".google.com") ||
    d === "youtube.com" ||
    d.endsWith(".youtube.com")
  );
}

/**
 * True when the Netscape jar carries at least one AUTH_COOKIE_NAMES entry for a google.com or
 * youtube.com domain WITH A NON-EMPTY VALUE.
 *
 * The non-empty check is not defensive padding, it is half the function: yt-dlp's `unpad_pkcs7`
 * does no validation, so a wrong-key decrypt (a sidecar that grew a keyring and started writing
 * v11 cookies, say) frequently yields a perfectly well-formed 7-field line whose value column is
 * the empty string. A jar full of those looks signed-in by name and authenticates nothing.
 *
 * Reads names and measures lengths; returns a boolean. No part of the jar leaves the function.
 */
export function hasAuthCookie(jarText: string): boolean {
  for (const raw of jarText.split("\n")) {
    // Tolerate CRLF. A jar pasted out of a Windows editor keeps its \r, and it would otherwise
    // ride along on the VALUE field and make an empty value measure as one character.
    const fields = raw.replace(/\r$/, "").split("\t");
    // Same exactness as countCookieLines: 7 fields, no more, no fewer.
    if (fields.length !== 7) continue;
    if (!AUTH_COOKIE_NAMES.has(fields[5] ?? "")) continue;
    if (!isGoogleDomain(fields[0] ?? "")) continue;
    if ((fields[6] ?? "").trim().length === 0) continue;
    return true;
  }
  return false;
}

/**
 * Parse `Extracted N cookies from <browser>` out of yt-dlp's STDOUT. null means the line was not
 * present — an older yt-dlp, or a run that never got as far as opening the profile. That is
 * "don't know", NOT "zero", and a caller must not collapse the two.
 *
 * This count is the only honest signal that a profile was empty. `--cookies-from-browser P
 * --cookies OUT` writes OUT *after* the HTTP request, so OUT always ends up holding the cookies
 * youtube.com hands an anonymous visitor even when P yielded nothing whatsoever; the number yt-dlp
 * prints, by contrast, is what it read out of the PROFILE. It goes to stdout, and it is printed
 * even under --no-warnings.
 */
export function extractedCookieCount(stdout: string): number | null {
  // Unanchored on purpose: yt-dlp prefixes the line under some verbosity settings, and the exact
  // prefix is not worth pinning. The trailing space is what guarantees a browser name follows.
  const m = /Extracted (\d+) cookies from /.exec(stdout);
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** Reasons that are ALWAYS these exact strings — no interpolation of anything external. */
const REASON_WRITE_FAILED = "could not write the cookie jar (disk full or CACHE_DIR unwritable?)";
const REASON_NO_COOKIES = "no cookies found in that text";
const REASON_INTERNAL = "internal error";
const REASON_PROFILE_UNREADABLE = "the browser profile is not readable (is the sidecar up?)";

/**
 * The import's verdicts. Each one names the NEXT ACTION, because "it didn't work" on its own is
 * what sends an operator back to re-pasting cookies at random — and the whole point of the two
 * profile ones is that the operation the console used to call a success was the one destroying
 * the session.
 */
const REASON_NOT_SIGNED_IN =
  "that profile is not signed in to YouTube — sign in inside the browser sidecar, wait ~30s for Chromium to flush its cookies, then Import again";
const REASON_PROFILE_EMPTY =
  "yt-dlp read that profile but found no cookies at all — check COOKIE_BROWSER_PROFILE points at the chromium user-data-dir";
const REASON_NO_COOKIE_DB =
  "no chromium cookie database under that profile — is the sidecar up, and does its PUID match the bot's uid 10001?";

/** Warnings: the operation WORKED, and the operator would still be misled by silence. */
const WARNING_NO_AUTH_PASTE =
  "saved, but this jar carries no YouTube sign-in cookies (SID / __Secure-1PSID) — it will not get you past a bot check";
const WARNING_UNDECRYPTABLE =
  "some cookies in that profile could not be decrypted and were dropped — the sidecar must run with --password-store=basic";

/** yt-dlp's two spellings for "the key was wrong, so I threw that cookie away". */
const UNDECRYPTABLE_RE = /could not be decrypted|cannot decrypt/i;

/** Does a regular file sit at `path`? Never throws — an EACCES parent is simply `false`. */
function isFileAt(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Short, operator-facing reason for a failed probe. Only ever the yt-dlp error KIND (a fixed
 * enum value) or one of our own literals — `err.message` is deliberately unreachable from here
 * because it embeds the raw stderr slice (cookie-file paths, proxy URLs, account hints).
 */
function probeReason(err: unknown): string {
  if (err instanceof YtError) {
    switch (err.kind) {
      // The whole point of the cookie jar: YouTube demanding a signed-in human.
      case YtErrorKind.IpBlocked:
        return "sign-in / bot check";
      case YtErrorKind.RateLimited:
        return "rate-limited by YouTube";
      case YtErrorKind.Timeout:
        return "yt-dlp timed out";
      case YtErrorKind.PoTokenSabr:
        return "extraction blocked (po_token / sabr)";
      default:
        // Kinds like unavailable/private say the PROBE VIDEO is the problem, not the cookies.
        return err.kind;
    }
  }
  if (isErrno(err) && err.code === "ENOENT") return "yt-dlp is not installed";
  return "extraction failed";
}

/**
 * Same job for the browser import, whose failures are their own species (a locked/absent
 * cookie DB, an unavailable keyring) that `classifyYtdlpError` only ever calls "unknown". The
 * patterns are matched against stderr but NOTHING from stderr is returned — each branch yields
 * a literal that tells the operator what to actually do.
 */
function importReason(stderr: string, code: number | null): string {
  if (/could not find|no such file|does not exist|not a directory/i.test(stderr)) {
    return "no chromium profile at that path — check the sidecar's volume mount";
  }
  if (
    /cookie database|database is locked|unable to open database|permission denied/i.test(stderr)
  ) {
    return "could not read the browser's cookie database (wrong profile dir, or it is locked)";
  }
  if (/decrypt|keyring|dbus|secret ?service/i.test(stderr)) {
    return "could not decrypt the browser cookies (the sidecar's keyring is unavailable)";
  }
  // Fall back to the shared classifier, and take ONLY its enum kind.
  return classifyYtdlpError(stderr, code).kind;
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

export class CookieService {
  private readonly cacheDir: string;
  private readonly jarPath: string;
  private readonly youtube: Pick<YouTubeService, "resolve">;
  private readonly browserProfile: string | null;
  private readonly applyCookies: (path: string | null) => void;
  private readonly run: RunFn;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  /** Set only when WE wrote the jar, which is what `updatedAt`/`source` are defined to report. */
  private lastWrite: { at: number; source: Exclude<CookieSource, "env" | "none"> } | null = null;
  private lastCheck: CookieHealth["lastCheck"] = null;
  /**
   * One writer at a time. A paste and a browser import both rewrite the same file and then
   * hot-apply it; interleaving them could leave the running extractor pointed at a jar that is
   * half one session and half another. Serializing also keeps the two probes from racing to
   * stamp `lastCheck` out of order. Public methods take the lock; the private helpers they call
   * must not (the Mutex is not reentrant).
   */
  private readonly lock = new Mutex();

  constructor(deps: CookieServiceDeps) {
    this.cacheDir = deps.cacheDir;
    this.jarPath = deps.jarPath;
    this.youtube = deps.youtube;
    this.browserProfile = deps.browserProfile;
    this.applyCookies = deps.applyCookies ?? setCookiesFile;
    this.run = deps.run ?? runYtDlp;
    this.timeoutMs = deps.ytdlpTimeoutMs ?? 60_000;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Cheap, synchronous, no network: does a jar exist, when did we last write it, what did the
   * last probe say, and is the sidecar profile actually usable right now. Called on every GET
   * /api/cookies, i.e. every time the console is opened, so its I/O budget is a handful of stats
   * plus at most ONE readdir (see `profileState`) — never a walk of a volume a browser fills with
   * cache files. And, like everything here, it cannot throw: an unreadable path is a `false`,
   * not a 500.
   *
   * `browserProfileAvailable` stays a plain boolean for the UI (it only gates the Import button);
   * the three-way `profileState` is what turns a failed import into an actionable reason.
   */
  health(): CookieHealth {
    const configured = this.jarExists();
    return {
      configured,
      // We only know the source of a jar WE wrote. Anything already on disk at boot came from
      // compose (an explicit YT_COOKIES mount, or YT_COOKIES_TEXT materialized at startup).
      source: this.lastWrite?.source ?? (configured ? "env" : "none"),
      updatedAt: this.lastWrite?.at ?? null,
      lastCheck: this.lastCheck,
      browserProfileAvailable: this.profileState() === "ok",
    };
  }

  /**
   * Prove the CURRENT jar still works by resolving a real video. Note it can legitimately
   * return ok:true with no jar at all — an unflagged IP needs no cookies — which is the honest
   * answer to "can the bot fetch right now?"; `health().configured` is the separate question of
   * whether a jar exists.
   */
  test(): Promise<CookieResult> {
    return this.exclusive("cookies:test", () => this.probe());
  }

  /**
   * Accept a paste (a cookies.txt export OR a DevTools `Cookie:` request header — the shared
   * `toNetscapeCookies` normalizer decides which), write it, hot-apply it, and immediately test
   * it. Returns the TEST's result, so "saved" alone never reads as "working".
   */
  saveFromText(text: string): Promise<CookieResult> {
    return this.exclusive("cookies:save", async () => {
      const jar = toNetscapeCookies(text);
      // Nothing usable in the paste (empty box, a screenshot's worth of prose, a JSON export we
      // don't speak). Say so without quoting a single character of what was pasted.
      if (countCookieLines(jar) === 0) return { ok: false, reason: REASON_NO_COOKIES };
      const writeFailed = await this.writeJar(jar);
      if (writeFailed !== null) return { ok: false, reason: writeFailed };
      this.lastWrite = { at: this.now(), source: "paste" };
      this.applyCookies(this.jarPath);
      const result = await this.probe();
      // A jar with no sign-in cookie is SAVED, not rejected: a consent-only jar is a legitimate
      // yt-dlp use case (it clears the EU consent interstitial) and the probe may well pass on an
      // unflagged IP, so refusing it would break a working setup. But it is also exactly what an
      // operator gets from copying `document.cookie` out of DevTools — the auth cookies are
      // HttpOnly and simply are not in that string — and they need to hear it now, rather than
      // conclude a week later that the bot check is unbeatable. Only the fixed literal is sent.
      if (!hasAuthCookie(jar)) return { ...result, warning: WARNING_NO_AUTH_PASTE };
      return result;
    });
  }

  /**
   * Lift the live session out of the LAN-only chromium sidecar. `--cookies-from-browser` reads the
   * profile and `--cookies` makes yt-dlp SAVE the resulting jar to a file of ours — that pairing is
   * the whole trick. It is also why the import goes to a STAGED file: yt-dlp LOADS `--cookies` as
   * well as writing it and saves the MERGE, so aiming it straight at the live jar would let the
   * stale session we are trying to replace survive the import. The staged jar REPLACES the live one
   * and does so as the very last step, which is what keeps a FAILED import from damaging a jar that
   * currently works.
   *
   * Every check below exists because of one specific defect. `--cookies-from-browser P --cookies
   * OUT` writes OUT *after* the HTTP request, so OUT always holds the eight cookies youtube.com
   * hands an anonymous visitor (PREF, SOCS, __Secure-YNID, GPS, YSC, __Secure-ROLLOUT_TOKEN,
   * VISITOR_INFO1_LIVE, VISITOR_PRIVACY_METADATA) even for a profile with nothing in it. "Is the
   * staged file non-empty?" therefore ALWAYS passed: an import from a not-signed-in profile
   * overwrote a working authenticated jar with an anonymous one, the probe passed too (PROBE_VIDEO_ID
   * is public and needs no auth), and the console reported "imported and working" for the exact
   * operation that had just destroyed the session. Nothing is promoted now until a real sign-in
   * cookie is in the staged file.
   */
  importFromBrowser(): Promise<CookieResult> {
    return this.exclusive("cookies:import", async () => {
      const profile = this.browserProfile;
      if (profile === null) {
        return { ok: false, reason: "no browser profile configured (set COOKIE_BROWSER_PROFILE)" };
      }
      // yt-dlp addresses a profile as `browser[+keyring][:profile][::container]`, so a path
      // containing ':' or '+' is parsed as something else entirely. Reject it here with a clear
      // reason instead of letting yt-dlp fail with a baffling one.
      if (/[:+]/.test(profile)) {
        return { ok: false, reason: "the browser profile path may not contain ':' or '+'" };
      }
      // Two different mistakes, two different fixes: nothing at that path at all (the sidecar is
      // down, the volume is not mounted, the uids do not match) versus a directory that reads fine
      // but holds no cookie DB (COOKIE_BROWSER_PROFILE aimed one level off the user-data-dir).
      // Both used to surface as one vague "not readable", or worse as a baffling yt-dlp failure.
      const state = this.profileState();
      if (state === "missing") return { ok: false, reason: REASON_PROFILE_UNREADABLE };
      if (state === "no-db") return { ok: false, reason: REASON_NO_COOKIE_DB };
      try {
        await mkdir(this.cacheDir, { recursive: true });
      } catch (err) {
        getRootLogger().error({ err, path: this.cacheDir }, "could not create CACHE_DIR");
        return { ok: false, reason: REASON_WRITE_FAILED };
      }
      // Import into a FRESH file, never straight into the live jar. yt-dlp LOADS --cookies as well
      // as --cookies-from-browser and saves the MERGE, so pointing it at an existing jar means the
      // stale cookies we are trying to replace survive the import — the console would report
      // success while changing nothing. Staging also preserves the useful property that a failed
      // import cannot damage a jar that currently works.
      const staged = `${this.jarPath}.import.${process.pid}.${Math.floor(this.now()).toString(36)}`;
      let run: YtDlpRun;
      try {
        run = await this.run(
          [
            "--cookies-from-browser",
            `chromium:${profile}`,
            "--cookies",
            staged,
            // Touch the network only as far as it takes to make yt-dlp load the browser jar and
            // save it back to our file; we never want the audio here.
            "--skip-download",
            "--simulate",
            "--no-playlist",
            // NOTE the absence of --no-warnings, which every other yt-dlp call in the bot passes.
            // A cookie yt-dlp cannot decrypt is reported as a WARNING and then dropped silently,
            // and that is precisely the failure that produces a jar which looks fine and is
            // missing the auth cookies. We want those warnings on stderr so the success path can
            // say so — the text itself never leaves this file, only WARNING_UNDECRYPTABLE does.
            "--no-progress",
            "--",
            `https://www.youtube.com/watch?v=${PROBE_VIDEO_ID}`,
          ],
          this.timeoutMs,
        );
      } catch (err) {
        // A timeout or a failed spawn — classified by kind, never by message.
        await this.discardStaged(staged);
        return { ok: false, reason: probeReason(err) };
      }
      if (run.code !== 0) {
        await this.discardStaged(staged);
        return { ok: false, reason: importReason(run.stderr, run.code) };
      }
      // yt-dlp exited clean. Three gates now stand between that and replacing a live session, in
      // increasing order of how much of the staged file they have to look at. EVERY failure below
      // discards the staged file and leaves the live jar exactly as it was.
      //
      // (a) yt-dlp's own count of what it read OUT OF THE PROFILE, before the request that
      // contaminates the file with anonymous cookies. A zero here is conclusive. A missing line
      // (older yt-dlp) parses to null, which means "don't know" and must fall through rather than
      // read as zero.
      if (extractedCookieCount(run.stdout) === 0) {
        await this.discardStaged(staged);
        return { ok: false, reason: REASON_NOT_SIGNED_IN };
      }
      let stagedJar: string | null = null;
      try {
        stagedJar = await readFile(staged, "utf8");
      } catch {
        stagedJar = null;
      }
      // (b) Nothing usable in the staged file at all: yt-dlp exited clean without writing a jar we
      // can read, or wrote one with no cookie lines in it. That is a plumbing problem — the wrong
      // directory, an unreadable staging path — not somebody forgetting to sign in.
      if (stagedJar === null || countCookieLines(stagedJar) === 0) {
        await this.discardStaged(staged);
        return { ok: false, reason: REASON_PROFILE_EMPTY };
      }
      // (c) THE FIX. Cookies, but no session: the eight anonymous ones satisfy (b) all by
      // themselves. Only a google.com/youtube.com auth cookie carrying an actual value proves
      // somebody was signed in when the profile was read.
      if (!hasAuthCookie(stagedJar)) {
        await this.discardStaged(staged);
        return { ok: false, reason: REASON_NOT_SIGNED_IN };
      }
      // Promote the staged jar over the live one — the browser session REPLACES what was there.
      try {
        await chmod(staged, 0o600);
        await rename(staged, this.jarPath);
      } catch (err) {
        getRootLogger().error({ err, path: this.jarPath }, "could not install the imported jar");
        await this.discardStaged(staged);
        return { ok: false, reason: REASON_WRITE_FAILED };
      }
      this.lastWrite = { at: this.now(), source: "browser" };
      this.applyCookies(this.jarPath);
      const result = await this.probe();
      // Dropped cookies do not fail the import — gate (c) proved a real auth cookie survived, and
      // what did decrypt may be a perfectly good session. But the operator has to hear about it:
      // the usual cause is a sidecar that acquired a keyring and started writing v11 cookies
      // instead of the v10 "peanuts" that --password-store=basic produces, and the symptom is a
      // session that half-works for a while. stderr itself never leaves this file.
      if (UNDECRYPTABLE_RE.test(run.stderr)) return { ...result, warning: WARNING_UNDECRYPTABLE };
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // internals — none of these take the lock, and none of them throw
  // -------------------------------------------------------------------------

  /** Remove a staged import file. Best-effort: a stranded temp must never fail the operation. */
  private async discardStaged(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      /* already gone, or unlinkable — nothing useful to do */
    }
  }

  /**
   * The real extraction behind `test()`, also used as the final step of both write paths.
   * Records `lastCheck` so `health()` can show the verdict without repeating the work.
   */
  private async probe(): Promise<CookieResult> {
    let result: CookieResult;
    try {
      await this.youtube.resolve(PROBE_VIDEO_ID);
      result = { ok: true, reason: null };
    } catch (err) {
      // DELIBERATELY not logging `err`: a yt-dlp failure carries its stderr slice, and this is
      // the one code path guaranteed to have been run with an authenticated jar.
      result = { ok: false, reason: probeReason(err) };
    }
    this.lastCheck = { at: this.now(), ok: result.ok, reason: result.reason };
    return result;
  }

  /**
   * Stage to a unique tmp sibling then rename over the jar. Atomic so a yt-dlp run in flight
   * never reads a half-written jar, and 0600 by construction — `writeFile`'s mode applies only
   * when it CREATES the file, so writing a fresh tmp and renaming is what guarantees the mode
   * even when the target already existed with looser permissions.
   *
   * Returns null on success, or a safe reason on failure. Never throws.
   */
  private async writeJar(text: string): Promise<string | null> {
    const tmp = `${this.jarPath}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.jarPath);
      return null;
    } catch (err) {
      // The path and the errno are safe to log; the TEXT is not, and is not logged.
      getRootLogger().error({ err, path: this.jarPath }, "could not write the cookie jar");
      // A failed rename would otherwise strand a staging file that holds a full session in
      // CACHE_DIR forever. Best-effort, and itself unable to throw.
      await unlink(tmp).catch(() => {});
      return REASON_WRITE_FAILED;
    }
  }

  /** EACCES on a parent dir counts as "no jar we can use", not as an error. */
  private jarExists(): boolean {
    return isFileAt(this.jarPath);
  }

  /**
   * Where the sidecar's profile stands, in the three states an operator can actually act on:
   *
   *  - "missing" — nothing usable at that path. The volume is unmounted, the sidecar has not
   *    started, or the directory belongs to another uid (profile dirs are owner-only, so the
   *    sidecar's PUID has to equal the bot's own uid).
   *  - "no-db"   — the directory reads fine but holds no chromium cookie database. Almost always
   *    COOKIE_BROWSER_PROFILE aimed one level off — at $HOME rather than the user-data-dir.
   *  - "ok"      — a cookie DB sits where yt-dlp is going to look for it.
   *
   * The candidate list is BOUNDED, and that is the point: this runs every time the console is
   * opened, against a volume a browser fills with tens of thousands of cache files, so it is a few
   * stats plus at most ONE readdir — never a walk. The paths are the ones chromium actually uses:
   * the modern network-service location first, the pre-split one second, each for the implicit
   * `Default` profile and for a user-data-dir that IS itself a profile, and finally the
   * `Profile N` siblings a second signed-in identity creates (the operator may well have signed
   * in there).
   *
   * X_OK as well as R_OK, because yt-dlp has to traverse into the directory to reach the DB.
   */
  private profileState(): "ok" | "missing" | "no-db" {
    const profile = this.browserProfile;
    // Unconfigured reports as "missing": there is no directory to be readable, and the callers
    // that care have already answered "no browser profile configured" before asking.
    if (profile === null) return "missing";
    try {
      if (!statSync(profile, { throwIfNoEntry: false })?.isDirectory()) return "missing";
      accessSync(profile, constants.R_OK | constants.X_OK);
    } catch {
      return "missing";
    }
    for (const rel of [
      "Default/Network/Cookies",
      "Default/Cookies",
      "Network/Cookies",
      "Cookies",
    ]) {
      if (isFileAt(join(profile, rel))) return "ok";
    }
    let entries: string[];
    try {
      entries = readdirSync(profile);
    } catch {
      // Readable enough to stat and traverse, not readable enough to list: we cannot prove a DB
      // is there, and "no-db" is the honest, actionable answer.
      return "no-db";
    }
    for (const entry of entries) {
      if (!entry.startsWith("Profile ")) continue;
      if (isFileAt(join(profile, entry, "Network", "Cookies"))) return "ok";
      if (isFileAt(join(profile, entry, "Cookies"))) return "ok";
    }
    return "no-db";
  }

  /**
   * Run one console task under the write lock and guarantee a resolved `CookieResult`. The
   * bodies above already convert every expected failure into a reason, so reaching this catch
   * means a bug — which still must not throw out of a route handler.
   */
  private async exclusive(label: string, fn: () => Promise<CookieResult>): Promise<CookieResult> {
    try {
      return await this.lock.runExclusive(fn);
    } catch (err) {
      getRootLogger().error({ err, label }, "cookie console task failed unexpectedly");
      return { ok: false, reason: REASON_INTERNAL };
    }
  }
}
