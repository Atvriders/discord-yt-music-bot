import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMediaConfig, materializeCookies } from "./config.js";
import { defaultJarPath } from "./cookies/index.js";
import { createLogger, setRootLogger } from "./util/logger.js";

// The degradation path below logs its failure through the root logger on purpose. Silence it so
// the suite's output stays clean (and so we prove nothing crashes while it logs).
beforeAll(() => setRootLogger(createLogger("silent")));

// yt-dlp does not merely READ the file given to --cookies: it writes the jar BACK after each run,
// so YouTube's constantly-rotating auth tokens (__Secure-*SIDTS, SIDCC, …) stay fresh on disk by
// themselves. Rewriting the file from YT_COOKIES_TEXT on every boot destroyed that and reset the
// session to the ORIGINAL paste, which ages out in a couple of weeks and lands the bot on
// "Sign in to confirm you're not a bot" — turning a self-maintaining session into a recurring
// manual chore. It bites hardest here, where every image pull restarts the container. These
// tests pin the cases that matter.
describe("materializeCookies preserves the jar yt-dlp keeps rotating", () => {
  let dir: string;
  const PASTE =
    "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\toriginal\n";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ytbot-cookies-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const media = (text: string) => loadMediaConfig({ CACHE_DIR: dir, YT_COOKIES_TEXT: text });

  it("writes the jar on first boot when none exists", async () => {
    const path = await materializeCookies(media(PASTE));
    expect(path).toBe(join(dir, "yt-cookies.txt"));
    expect(await readFile(path!, "utf8")).toContain("SID\toriginal");
  });

  it("writes the jar 0600 — it holds a signed-in Google session", async () => {
    const path = (await materializeCookies(media(PASTE)))!;
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  it("does NOT clobber a rotated jar when the pasted cookies are unchanged", async () => {
    const path = (await materializeCookies(media(PASTE)))!;
    // Stand in for yt-dlp writing back refreshed tokens after a run.
    const rotated =
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tROTATED-BY-YTDLP\n";
    await writeFile(path, rotated);

    // Restart with the SAME paste: the fresh jar must survive.
    const again = await materializeCookies(media(PASTE));
    expect(again).toBe(path);
    expect(await readFile(path, "utf8")).toContain("ROTATED-BY-YTDLP");
    expect(await readFile(path, "utf8")).not.toContain("SID\toriginal");
  });

  it("survives MANY restarts, not just the second one", async () => {
    const path = (await materializeCookies(media(PASTE)))!;
    await writeFile(
      path,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tROTATED\n",
    );
    // Ten boots with the same compose file — the stamp comparison must hold every time, not
    // decay after the first (e.g. if the stamp file were only written on the initial write).
    for (let i = 0; i < 10; i++) await materializeCookies(media(PASTE));
    expect(await readFile(path, "utf8")).toContain("SID\tROTATED");
  });

  it("DOES rewrite when the operator pastes different cookies (their paste wins)", async () => {
    const path = (await materializeCookies(media(PASTE)))!;
    await writeFile(
      path,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\tstale\n",
    );

    const fresh =
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tBRAND-NEW\n";
    const again = await materializeCookies(media(fresh));
    expect(again).toBe(path);
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toContain("SID\tBRAND-NEW");
    expect(onDisk).not.toContain("SID\tstale");
  });

  it("rewrites a jar that went missing even though the stamp survived", async () => {
    const path = (await materializeCookies(media(PASTE)))!;
    // The stamp file stays; only the jar is gone (someone cleared it, a partial volume wipe).
    // "Same paste as last boot" must not be allowed to mean "so write nothing".
    await rm(path);
    expect(await materializeCookies(media(PASTE))).toBe(path);
    expect(await readFile(path, "utf8")).toContain("SID\toriginal");
  });

  it("degrades to null instead of throwing when CACHE_DIR cannot be written", async () => {
    // A file where the cache DIRECTORY should be: mkdir/writeFile both fail (ENOTDIR). This is
    // the ENOSPC/unwritable-volume class, and it must not crash-loop the container over cookies.
    const notADir = join(dir, "occupied");
    await writeFile(notADir, "");
    const cfg = loadMediaConfig({ CACHE_DIR: notADir, YT_COOKIES_TEXT: PASTE });
    await expect(materializeCookies(cfg)).resolves.toBeNull();
  });
});

// config.ts cannot import src/cookies (that module imports toNetscapeCookies from config.ts), so
// the jar filename is spelled out in both places. This is the test that keeps them honest: if
// they ever drift, the console would report on and rewrite a DIFFERENT file than the extractor
// reads — a paste that appears to save and changes nothing.
describe("the console and the extractor agree on the jar path", () => {
  it("defaultJarPath matches what materializeCookies writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ytbot-cookies-"));
    try {
      const written = await materializeCookies(
        loadMediaConfig({
          CACHE_DIR: dir,
          YT_COOKIES_TEXT: ".youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tx",
        }),
      );
      expect(written).toBe(defaultJarPath(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
