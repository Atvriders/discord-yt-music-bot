# discord-yt-music-bot — Plan 5: Deployment & Production Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make the bot production-operable: structured logging, a startup extraction canary, hardened `/healthz`, graceful shutdown, an **active-session snapshot** that survives restarts, and the full container/CI stack (multi-stage Dockerfile with `yt-dlp[default]`+Deno+ffmpeg, `docker-compose` pulling the GHCR image with an optional PO-token sidecar, and a GitHub Actions workflow that publishes to GHCR on push **and on a weekly schedule** so yt-dlp stays fresh).

**Architecture:** New `src/util/logger.ts` (pino) and `src/lifecycle.ts` (crash handlers + graceful-shutdown runner) are pure/testable. `src/canary.ts` smoke-tests extraction on boot. `src/orchestrator/snapshot.ts` serializes each `GuildController`'s connected channel + queue to a JSON file on the cache volume (debounced on `"changed"`) and restores on boot — implemented behind small additions to `GuildController` (`connectedChannelId`, `restore`) and `GuildHub` (`guildIds`/`controllers`). `index.ts` wires it all into the process lifecycle. The Dockerfile/compose/CI are authored from the verified reference (the sandbox has no Docker; they are structurally correct and run on the user's host / GitHub).

**Companion reference:** [verified API reference](../research/2026-06-25-verified-api-reference.md) §1 (yt-dlp env), §4 (Docker/compose/CI). **Spec:** [design spec](../specs/2026-06-25-discord-yt-music-bot-design.md) §4.1 (snapshot), §11 (lifecycle/observability), §13 (env), §14 (deploy).

**Consumes from Plans 1–4:** `GuildHub`, `GuildController` (`ensureConnected`, `enqueue`, `snapshot`, its `queue` emitter), `VoiceSession.channelId`, `YouTubeService.resolve`, `AudioCache`, `loadMediaConfig`/`loadBotConfig`/`loadWebConfig`, `buildApp`, `createBot`, the discord.js `Client`.

## Global Constraints

- Node 22.12+ target, ESM NodeNext (**`.js` imports**), strict TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), no DOM in the backend tsconfig.
- **yt-dlp in the image:** installed via **`pip install "yt-dlp[default]"`** (bundles the nsig EJS solver), with **Deno** on PATH; ffmpeg from apt. Base `node:22.x-bookworm` (build) / `-slim` (runtime). Run as **non-root**. yt-dlp/ffmpeg/Deno only in the runtime stage.
- **GHCR:** image `ghcr.io/atvriders/discord-yt-music-bot`; CI needs `permissions: { contents: read, packages: write }`; `on: { push:[master], workflow_dispatch, schedule: weekly }`; tag `:latest` + `:${{github.sha}}`. The package is **private by default** (make Public once); a fork's first build needs manual `workflow_dispatch`.
- **compose** PULLS the image (`image:`, no `build:`), `env_file: .env`, named volume at `CACHE_DIR`, `restart: unless-stopped`, `/healthz` healthcheck, json-file log rotation; the bgutil POT sidecar is `profiles: ["pot"]`.
- **Snapshot** is best-effort: on restore, a guild's tracks are re-queued (current restarts from 0; mid-track position resume is out of scope). It must never crash boot — a malformed/absent file is ignored.
- **Graceful shutdown** must be idempotent and bounded by a grace timer (force-exit).
- Secrets never logged. Commits conventional; branch `plan-5-deploy`; squash-merge at the end.

---

## File Structure (Plan 5)

```
src/
├── util/logger.ts               # T1 (+test)
├── config.ts                    # T1 — logLevel on BotConfig (or a small WebConfig/MediaConfig addition)
├── lifecycle.ts                 # T2 — crash handlers + runShutdown (+test)
├── canary.ts                    # T3 — startupCanary (+test)
├── server/app.ts                # T3 — /healthz hardening
├── orchestrator/
│   ├── index.ts                 # T4 — GuildController.connectedChannelId + restore()
│   ├── hub.ts                   # T4 — GuildHub.guildIds()/controllers()
│   └── snapshot.ts              # T4 — collect/write/read/restore (+test)
└── index.ts                     # T5 — wire logging, canary, snapshot, shutdown
Dockerfile                       # T6
.dockerignore                    # T6 (exists — verify)
.env.example                     # T6
docker-compose.yml               # T7
.github/workflows/build.yml      # T7
README.md                        # T7 — deploy section
```

---

### Task 1: Structured logging (pino)

**Files:** `package.json`, `src/util/logger.ts`, `src/util/logger.test.ts`, `src/types/config-types.ts` (+`logLevel`), `src/config.ts`.

- [ ] **Step 1: Install pino** — `npm install pino` (EBADENGINE fine).
- [ ] **Step 2: Add `logLevel: string` to `BotConfig`** in `config-types.ts`, and in `loadBotConfig` set `logLevel: strEnv(env, "LOG_LEVEL") ?? "info"`. Add a bot-config test asserting the default + override.
- [ ] **Step 3: Write the failing logger test** `src/util/logger.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("creates a logger at the requested level", () => {
    const log = createLogger("warn");
    expect(log.level).toBe("warn");
    expect(typeof log.info).toBe("function");
  });
  it("defaults to info for an unknown level", () => {
    expect(createLogger("nonsense").level).toBe("info");
  });
});
```
- [ ] **Step 4: Implement `src/util/logger.ts`**:
```ts
import pino, { type Logger } from "pino";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function createLogger(level = "info"): Logger {
  return pino({ level: LEVELS.has(level) ? level : "info", base: undefined });
}
```
- [ ] **Step 5: Run tests + typecheck + lint, commit** `feat(obs): add pino structured logger + LOG_LEVEL`.

---

### Task 2: Lifecycle — crash handlers + graceful shutdown

**Files:** `src/lifecycle.ts`, `src/lifecycle.test.ts`

**Interfaces:** `installCrashHandlers(log)`; `runShutdown(tasks, opts): Promise<void>` (runs each task, swallowing individual errors, bounded by `graceMs` via an injected `setTimeoutFn`/`exitFn`); `installSignalHandlers(tasks, opts)`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect, vi } from "vitest";
import { runShutdown } from "./lifecycle.js";

describe("runShutdown", () => {
  it("runs every task even if one throws, then resolves", async () => {
    const order: string[] = [];
    await runShutdown(
      [async () => { order.push("a"); }, async () => { throw new Error("b fails"); }, async () => { order.push("c"); }],
      { graceMs: 1000 },
    );
    expect(order).toEqual(["a", "c"]);
  });
  it("force-exits if a task hangs past graceMs", async () => {
    const exit = vi.fn();
    await runShutdown([() => new Promise(() => {})], { graceMs: 5, exitFn: exit });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
```
- [ ] **Step 2: Implement `src/lifecycle.ts`**
```ts
import type { Logger } from "pino";

export interface ShutdownOpts { graceMs: number; exitFn?: (code: number) => void; }
type Task = () => Promise<void> | void;

export async function runShutdown(tasks: Task[], opts: ShutdownOpts): Promise<void> {
  const exit = opts.exitFn ?? ((c) => process.exit(c));
  let forced = false;
  const timer = setTimeout(() => { forced = true; exit(1); }, opts.graceMs);
  if (typeof timer.unref === "function") timer.unref();
  for (const task of tasks) {
    if (forced) return;
    try { await task(); } catch { /* shutdown is best-effort */ }
  }
  clearTimeout(timer);
}

export function installSignalHandlers(tasks: Task[], opts: ShutdownOpts, log?: Logger): void {
  let started = false;
  const handler = (sig: string) => {
    if (started) return;
    started = true;
    log?.info({ sig }, "shutting down");
    void runShutdown(tasks, opts).then(() => (opts.exitFn ?? ((c) => process.exit(c)))(0));
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

export function installCrashHandlers(log: Logger): void {
  process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandledRejection"));
  process.on("uncaughtException", (err) => log.error({ err }, "uncaughtException"));
}
```
- [ ] **Step 3: Run tests + typecheck + lint, commit** `feat(lifecycle): add crash handlers + graceful shutdown runner`.

---

### Task 3: Startup canary + `/healthz` hardening

**Files:** `src/canary.ts`, `src/canary.test.ts`, `src/server/app.ts`, `src/server/app.test.ts`.

- [ ] **Step 1: Canary failing test** (`KNOWN_GOOD_VIDEO_ID` resolves → ok; throw → not ok, logged):
```ts
import { describe, it, expect, vi } from "vitest";
import { startupCanary } from "./canary.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("startupCanary", () => {
  it("returns true when a known video resolves", async () => {
    const youtube = { resolve: vi.fn(async () => ({ title: "ok" })) };
    expect(await startupCanary(youtube as never, log)).toBe(true);
    expect(youtube.resolve).toHaveBeenCalled();
  });
  it("returns false and logs when resolution fails", async () => {
    const youtube = { resolve: vi.fn(async () => { throw new Error("blocked"); }) };
    expect(await startupCanary(youtube as never, log)).toBe(false);
  });
});
```
- [ ] **Step 2: Implement `src/canary.ts`**
```ts
import type { Logger } from "pino";
import type { YouTubeService } from "./youtube/index.js";

// "Me at the zoo" — the first, permanently-public YouTube video.
const KNOWN_GOOD_VIDEO_ID = "jNQXAC9IVRw";

export async function startupCanary(youtube: Pick<YouTubeService, "resolve">, log: Logger): Promise<boolean> {
  try {
    const meta = await youtube.resolve(KNOWN_GOOD_VIDEO_ID);
    log.info({ title: meta.title }, "extraction canary passed");
    return true;
  } catch (err) {
    log.error({ err }, "extraction canary FAILED — yt-dlp may be stale or the IP blocked");
    return false;
  }
}
```
- [ ] **Step 3: Harden `/healthz`** in `src/server/app.ts`: accept an optional `gatewayReady?: () => boolean` on `AppDeps` and return `{ ok: true, gateway: deps.gatewayReady?.() ?? null, uptimeSec: Math.floor(process.uptime()) }`. Update the `app.test.ts` healthz test to assert `ok: true` is present (and that a provided `gatewayReady` is reflected).
- [ ] **Step 4: Run tests + typecheck + lint, commit** `feat(obs): add startup extraction canary + richer /healthz`.

---

### Task 4: Active-session snapshot

**Files:** `src/orchestrator/snapshot.ts`, `src/orchestrator/snapshot.test.ts`, `src/orchestrator/index.ts` (+`connectedChannelId`, `restore`), `src/orchestrator/hub.ts` (+`guildIds`/`controllers`).

**Interfaces:**
```ts
interface GuildSnap { guildId: string; voiceChannelId: string; items: QueueItem[]; } // items[0] = current
interface SnapshotFile { version: 1; savedAt: number; guilds: GuildSnap[]; }
collectSnapshot(hub, now): SnapshotFile
writeSnapshot(dir, file): Promise<void>          // atomic: tmp + rename
readSnapshot(dir): Promise<SnapshotFile | null>  // null on missing/corrupt
restoreSnapshot(file, hub, log): Promise<void>   // per guild: controller.restore(channelId, items)
```

- [ ] **Step 1: Add to `GuildController` (`src/orchestrator/index.ts`)**:
```ts
  get connectedChannelId(): string | null {
    return this.session?.channelId ?? null;
  }
  async restore(channelId: string, items: QueueItem[]): Promise<void> {
    await this.ensureConnected(channelId);
    for (const it of items) await this.queue.add(it.meta, it.requester);
    // maybeStart fires via the queue "changed" listener.
  }
```
(`VoiceSession` already exposes `channelId`.)

- [ ] **Step 2: Add to `GuildHub` (`src/orchestrator/hub.ts`)**:
```ts
  guildIds(): string[] { return [...this.controllers.keys()]; }
  controllers(): IterableIterator<GuildController> { return this.controllers.values(); }
```
(Rename the private field if it collides with the new method name — use `#map` or `private readonly map`.)

- [ ] **Step 3: Failing snapshot test** (fake hub + controllers; temp dir for write/read):
```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot, writeSnapshot, readSnapshot, restoreSnapshot } from "./snapshot.js";

const meta = (id: string) => ({ videoId: id, title: id, channel: "c", durationSec: 1, isLive: false, thumbnailUrl: null });
const requester = { discordUserId: "1", displayName: "u", avatarUrl: "a", source: "discord" as const };
const item = (id: string) => ({ id: `i-${id}`, meta: meta(id), requester, addedAt: 0 });

function fakeController(channelId: string | null, current: unknown, upcoming: unknown[]) {
  return { connectedChannelId: channelId, snapshot: () => ({ current, upcoming, history: [] }), restore: vi.fn(async () => {}) };
}

describe("snapshot", () => {
  it("collects connected guilds with current+upcoming, skips disconnected", () => {
    const hub = { guildIds: () => ["G1", "G2"], get: (g: string) => g === "G1"
      ? fakeController("C1", item("aaaaaaaaaaa"), [item("bbbbbbbbbbb")])
      : fakeController(null, null, []) };
    const file = collectSnapshot(hub as never, 123);
    expect(file.guilds).toHaveLength(1);
    expect(file.guilds[0]).toMatchObject({ guildId: "G1", voiceChannelId: "C1" });
    expect(file.guilds[0]!.items.map((i) => i.meta.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
  });

  it("round-trips through disk and ignores a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-"));
    expect(await readSnapshot(dir)).toBeNull();
    const file = { version: 1 as const, savedAt: 1, guilds: [{ guildId: "G1", voiceChannelId: "C1", items: [item("aaaaaaaaaaa")] }] };
    await writeSnapshot(dir, file);
    expect(await readSnapshot(dir)).toEqual(file);
    await rm(dir, { recursive: true, force: true });
  });

  it("restores each guild via controller.restore", async () => {
    const c = fakeController("C1", null, []);
    const hub = { get: () => c };
    await restoreSnapshot({ version: 1, savedAt: 1, guilds: [{ guildId: "G1", voiceChannelId: "C1", items: [item("aaaaaaaaaaa")] }] } as never, hub as never, { info: vi.fn(), error: vi.fn() } as never);
    expect(c.restore).toHaveBeenCalledWith("C1", expect.arrayContaining([expect.objectContaining({ id: "i-aaaaaaaaaaa" })]));
  });
});
```

- [ ] **Step 4: Implement `src/orchestrator/snapshot.ts`**
```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { QueueItem } from "../types/index.js";

export interface GuildSnap { guildId: string; voiceChannelId: string; items: QueueItem[]; }
export interface SnapshotFile { version: 1; savedAt: number; guilds: GuildSnap[]; }

interface ControllerLike {
  connectedChannelId: string | null;
  snapshot(): { current: QueueItem | null; upcoming: QueueItem[] };
  restore(channelId: string, items: QueueItem[]): Promise<void>;
}
interface HubLike { guildIds(): string[]; get(guildId: string): ControllerLike; }

const FILE = "session-snapshot.json";

export function collectSnapshot(hub: HubLike, now: number): SnapshotFile {
  const guilds: GuildSnap[] = [];
  for (const guildId of hub.guildIds()) {
    const c = hub.get(guildId);
    const channelId = c.connectedChannelId;
    if (!channelId) continue;
    const snap = c.snapshot();
    const items = [...(snap.current ? [snap.current] : []), ...snap.upcoming];
    if (items.length === 0) continue;
    guilds.push({ guildId, voiceChannelId: channelId, items });
  }
  return { version: 1, savedAt: now, guilds };
}

export async function writeSnapshot(dir: string, file: SnapshotFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(file));
  await rename(tmp, join(dir, FILE)); // atomic swap
}

export async function readSnapshot(dir: string): Promise<SnapshotFile | null> {
  try {
    const raw = await readFile(join(dir, FILE), "utf8");
    const parsed = JSON.parse(raw) as SnapshotFile;
    return parsed.version === 1 && Array.isArray(parsed.guilds) ? parsed : null;
  } catch {
    return null;
  }
}

export async function restoreSnapshot(file: SnapshotFile, hub: { get(g: string): ControllerLike }, log: Pick<Logger, "info" | "error">): Promise<void> {
  for (const g of file.guilds) {
    try {
      await hub.get(g.guildId).restore(g.voiceChannelId, g.items);
      log.info({ guildId: g.guildId, tracks: g.items.length }, "restored session");
    } catch (err) {
      log.error({ guildId: g.guildId, err }, "failed to restore session");
    }
  }
}
```

- [ ] **Step 5: Run tests + typecheck + lint, commit** `feat(snapshot): persist + restore per-guild active sessions`.

---

### Task 5: Wire lifecycle, canary, snapshot, logging into `index.ts`

**Files:** `src/index.ts`, `src/server/app.ts` (pass `gatewayReady`).

- [ ] **Step 1: Update `main()` in `src/index.ts`** to:
  1. `const log = createLogger(bot.logLevel);` and `installCrashHandlers(log)` early.
  2. After `client.login(...)` + `app.listen(...)`, run `await startupCanary(youtube, log)` (log only — don't abort).
  3. On boot, `const snap = await readSnapshot(media.cacheDir); if (snap) await restoreSnapshot(snap, hub, log);` (after the client is ready — wrap in `client.once("ready", …)` or `await entersState`-style readiness; simplest: call it after `client.login` resolves and a short ready wait).
  4. Wire a **debounced snapshot writer**: subscribe each created controller's `queue.on("changed", scheduleSnapshot)` where `scheduleSnapshot` debounces (e.g. 3 s) a `writeSnapshot(media.cacheDir, collectSnapshot(hub, Date.now()))`. (Add the listener in the `GuildHub` factory closure, or iterate `hub.controllers()` after creation — but controllers are lazy; simplest is to attach the listener inside the factory when a controller is created.)
  5. Build the shutdown task list and `installSignalHandlers([...], { graceMs: 8000 }, log)`: flush a final snapshot (`await writeSnapshot(...)`), destroy all voice sessions (iterate `hub.controllers()` → `await c.stop()` or a new `c.leaveQuietly()`), `await app.close()`.
  6. Pass `gatewayReady: () => client.isReady()` into `buildApp`.
- [ ] **Step 2: Replace `console.log`/`console.error`** in `index.ts`/`bot.ts` with `log.*` (pass the logger into `createBot` via deps, or keep a module logger). Keep it minimal — the bot's existing `console.error` in the message-handler catch can become `log.error`.
- [ ] **Step 3: Verify** `npm test && npm run typecheck && npm run lint && npm run build` — green. (The wiring isn't unit-run; it must typecheck + the suite stays green.)
- [ ] **Step 4: Commit** `feat(lifecycle): wire logging, canary, snapshot, and graceful shutdown into the process`.

---

### Task 6: Dockerfile, .dockerignore, .env.example

**Files:** `Dockerfile`, `.dockerignore`, `.env.example`.

- [ ] **Step 1: `Dockerfile`** (multi-stage; verified-reference §4):
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 CACHE_DIR=/data/cache PATH="/usr/local/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" && yt-dlp --version
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- --yes && deno --version
WORKDIR /app
RUN useradd --create-home --uid 10001 app && mkdir -p "${CACHE_DIR}" && chown -R app:app "${CACHE_DIR}" /app
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
USER app
VOLUME ["/data/cache"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```
- [ ] **Step 2: Verify `.dockerignore`** contains `node_modules dist web/dist .git *.log .env .superpowers` (add the missing ones).
- [ ] **Step 3: `.env.example`** — all env vars with placeholder values + a one-line comment each: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `OAUTH_REDIRECT_URI`, `SESSION_SECRET`, `ADMIN_USER_IDS`, `PORT`, `HOST`, `TRUST_PROXY`, `LOG_LEVEL`, `NODE_ENV`, `CACHE_DIR`, `CACHE_MAX_MB`, `IDLE_TIMEOUT_SEC`, `HISTORY_MAX_ITEMS`, `SEARCH_RESULT_COUNT`, `PREFETCH_DEPTH`, `MAX_TRANSCODE_JOBS`, `MAX_TRACK_DURATION_SEC`, `SPONSORBLOCK_REMOVE`, `NORMALIZE_LOUDNESS`, `YT_PROXY`, `YT_COOKIES`, `PO_TOKEN_PROVIDER_URL`, `YT_PLAYER_CLIENTS`, `ALLOWED_WS_ORIGINS`.
- [ ] **Step 4: Verify + commit** — `npm run build` still green; the Dockerfile is config (not built here). Commit `feat(deploy): add multi-stage Dockerfile and .env.example`.

---

### Task 7: docker-compose, GitHub Actions, README deploy

**Files:** `docker-compose.yml`, `.github/workflows/build.yml`, `README.md`.

- [ ] **Step 1: `docker-compose.yml`** (verified-reference §4):
```yaml
services:
  bot:
    image: ghcr.io/atvriders/discord-yt-music-bot:latest
    pull_policy: always
    env_file: .env
    environment:
      PO_TOKEN_PROVIDER_URL: "${PO_TOKEN_PROVIDER_URL:-}"
    ports: ["${PORT:-8080}:8080"]
    volumes: ["cache:/data/cache"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD","node","-e","fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 25s
      retries: 3
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
  bgutil-pot:
    image: brainicism/bgutil-ytdlp-pot-provider:latest
    profiles: ["pot"]
    restart: unless-stopped
    expose: ["4416"]
volumes:
  cache:
```
- [ ] **Step 2: `.github/workflows/build.yml`** (verified-reference §4):
```yaml
name: build
on:
  push: { branches: [master] }
  workflow_dispatch: {}
  schedule:
    - cron: "0 6 * * 1"   # weekly — refresh yt-dlp/ejs
permissions: { contents: read, packages: write }
env: { REGISTRY: ghcr.io, IMAGE_NAME: atvriders/discord-yt-music-bot }
jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: "${{ env.REGISTRY }}", username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```
- [ ] **Step 3: README "Deploy" section** — `docker compose up -d` (pulls GHCR); set the GHCR package **Public** once; a fork's first build needs manual `workflow_dispatch`; the weekly schedule keeps yt-dlp fresh; `--profile pot` to enable the PO-token sidecar (set `PO_TOKEN_PROVIDER_URL=http://bgutil-pot:4416`); `OAUTH_REDIRECT_URI` must be the public `…/auth/callback`; the named `cache` volume holds the audio cache + the session snapshot.
- [ ] **Step 4: Final verification + commit** — `npm test && npm run typecheck && npm run lint && npm run build` green. Commit `feat(deploy): add docker-compose, GHCR CI workflow, and deploy docs`.

---

## Self-Review

**1. Spec coverage (Plan 5 = deploy + §11/§14):** structured logging (pino) → T1 ✔; graceful shutdown (SIGTERM, bounded, leaves voice, flushes snapshot, closes server) → T2,T5 ✔; crash handlers → T2 ✔; startup canary + version → T3 ✔; `/healthz` gateway+uptime → T3 ✔; active-session snapshot (persist debounced, restore on boot, atomic write, corrupt-safe) → T4,T5 ✔; multi-stage Dockerfile (`yt-dlp[default]`+Deno+ffmpeg, non-root, healthcheck) → T6 ✔; compose (pull GHCR, env, volume, restart, log rotation, POT sidecar) → T7 ✔; GitHub Actions (GHCR, permissions, push+dispatch+weekly, SHA tags) → T7 ✔; `.env.example` (all §13 vars) → T6 ✔. **Already present (verify, don't rebuild):** global download concurrency cap (the shared `Semaphore` in `index.ts`), `unhandledRejection` (Plan 2/3). **Out of scope:** mid-track position resume (snapshot restarts current from 0 — documented).

**2. Placeholder scan:** none — testable tasks (T1–T4) have full code + tests; config tasks (T6–T7) have complete file contents from the verified reference. T5 is wiring with an explicit step list (the only non-unit-tested glue; verified by typecheck + the suite staying green).

**3. Type consistency:** `createLogger`→`Logger` (T1) used by T2/3/4/5; `runShutdown`/`installSignalHandlers`/`installCrashHandlers` (T2) by T5; `startupCanary` (T3) by T5; `collect/write/read/restoreSnapshot` + `GuildSnap`/`SnapshotFile` (T4) by T5; `GuildController.connectedChannelId`/`restore` + `GuildHub.guildIds`/`controllers` (T4) consumed by the snapshot module + T5. `QueueItem` matches Plan 1. `gatewayReady` threads from `index.ts` → `buildApp` → `/healthz`.

**4. Sandbox reality:** T1–T5 are unit-tested + typechecked; T6–T7 are Docker/CI config that can't run in-sandbox (no Docker, no GitHub remote) but are authored from the web-verified reference and run on the user's host / GitHub on push.
