import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieService, defaultJarPath } from "./index.js";
import { YouTubeService, resetCookiesFileForTests } from "../youtube/index.js";
import { loadMediaConfig } from "../config.js";
import { createLogger, setRootLogger } from "../util/logger.js";
import type { YtDlpRun } from "../youtube/ytdlp.js";

/**
 * The seam between the console and the extractor, tested end to end with the REAL default
 * wiring — `CookieService` constructed WITHOUT an `applyCookies` override, so it falls back to
 * the YouTubeService module setter exactly as main() leaves it.
 *
 * Every other test stubs one side of this: the console suite spies on `applyCookies`, and the
 * hot-apply suite calls `setCookiesFile` by hand. Both would still pass if the default were
 * wired to nothing at all — which is precisely the failure that makes a paste report "saved and
 * working" while every subsequent download runs signed-out.
 */

const SECRET = "s3cr3t-SID-value-do-not-echo-9f2a1c";
const JAR = [
  "# Netscape HTTP Cookie File",
  `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\t${SECRET}`,
].join("\n");

const INFO = JSON.stringify({
  id: "jNQXAC9IVRw",
  title: "Me at the zoo",
  uploader: "jawed",
  duration: 19,
  is_live: false,
});

beforeAll(() => setRootLogger(createLogger("silent")));

let dir: string;
beforeEach(async () => {
  resetCookiesFileForTests();
  dir = await mkdtemp(join(tmpdir(), "ytbot-cookies-wiring-"));
});
afterEach(async () => {
  resetCookiesFileForTests();
  await rm(dir, { recursive: true, force: true });
});

/** The `--cookies` path from the most recent spawn, or null when the run carried none. */
function cookiesArg(calls: string[][]): string | null {
  const args = calls.at(-1);
  if (!args) return null;
  const i = args.indexOf("--cookies");
  return i === -1 ? null : (args[i + 1] ?? null);
}

describe("console → extractor, with the real default wiring", () => {
  it("a pasted jar is what the NEXT yt-dlp run actually uses", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]): Promise<YtDlpRun> => {
      calls.push(args);
      return { stdout: INFO, stderr: "", code: 0 };
    });
    // No YT_COOKIES / YT_COOKIES_TEXT: this deploy starts with no jar at all, which is the case
    // where the console has to be able to establish one from nothing.
    const cfg = loadMediaConfig({ CACHE_DIR: dir });
    const youtube = new YouTubeService(cfg, run);

    await youtube.resolve("jNQXAC9IVRw");
    expect(cookiesArg(calls)).toBeNull(); // nothing configured yet

    const svc = new CookieService({
      cacheDir: dir,
      jarPath: defaultJarPath(dir),
      youtube, // the probe runs through the same extractor
      browserProfile: null,
      // applyCookies deliberately omitted — this is the wiring under test.
      run: vi.fn(async (): Promise<YtDlpRun> => ({ stdout: "", stderr: "", code: 0 })),
      now: () => 1_700_000_000_000,
    });

    const result = await svc.saveFromText(JAR);
    expect(result.ok).toBe(true);
    // The probe itself already ran with the new jar — that is what makes "saved" mean "working".
    expect(cookiesArg(calls)).toBe(defaultJarPath(dir));

    // …and so does ordinary playback afterwards.
    await youtube.search("anything", 1);
    expect(cookiesArg(calls)).toBe(defaultJarPath(dir));
    expect(await readFile(defaultJarPath(dir), "utf8")).toContain(SECRET);
  });

  it("replaces the jar the deploy config pointed at, without a restart", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]): Promise<YtDlpRun> => {
      calls.push(args);
      return { stdout: INFO, stderr: "", code: 0 };
    });
    const mounted = join(dir, "mounted-cookies.txt");
    const cfg = loadMediaConfig({ CACHE_DIR: dir, YT_COOKIES: mounted });
    const youtube = new YouTubeService(cfg, run);

    await youtube.resolve("jNQXAC9IVRw");
    expect(cookiesArg(calls)).toBe(mounted);

    // main() passes the EFFECTIVE file as jarPath, so an operator who mounted their own
    // cookies.txt has the console rewrite that same file rather than a shadow copy the
    // extractor would never read.
    const svc = new CookieService({
      cacheDir: dir,
      jarPath: mounted,
      youtube,
      browserProfile: null,
      run: vi.fn(async (): Promise<YtDlpRun> => ({ stdout: "", stderr: "", code: 0 })),
      now: () => 1_700_000_000_000,
    });
    expect((await svc.saveFromText(JAR)).ok).toBe(true);

    await youtube.resolve("jNQXAC9IVRw");
    expect(cookiesArg(calls)).toBe(mounted);
    expect(await readFile(mounted, "utf8")).toContain(SECRET);
  });

  it("health() reports the jar the extractor is really reading", async () => {
    const cfg = loadMediaConfig({ CACHE_DIR: dir });
    const youtube = new YouTubeService(
      cfg,
      vi.fn(async (): Promise<YtDlpRun> => ({ stdout: INFO, stderr: "", code: 0 })),
    );
    const svc = new CookieService({
      cacheDir: dir,
      jarPath: defaultJarPath(dir),
      youtube,
      browserProfile: null,
      run: vi.fn(async (): Promise<YtDlpRun> => ({ stdout: "", stderr: "", code: 0 })),
      now: () => 1_700_000_000_000,
    });

    expect(svc.health()).toMatchObject({ configured: false, source: "none", updatedAt: null });
    await svc.saveFromText(JAR);
    expect(svc.health()).toMatchObject({
      configured: true,
      source: "paste",
      updatedAt: 1_700_000_000_000,
      lastCheck: { ok: true, reason: null },
    });
    // And nothing in the health blob carries a byte of the jar.
    expect(JSON.stringify(svc.health())).not.toContain(SECRET);
  });
});
