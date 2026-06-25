# discord-yt-music-bot — Plan 1: Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, externally-testable backend core of the bot — project scaffold, shared types, YouTube input parsing, the `yt-dlp` subprocess service, the on-disk audio cache, and the per-guild queue state machine — all with zero dependency on Discord, the network, or the web server.

**Architecture:** A TypeScript/Node 22 ESM library. The `youtube/` service wraps the `yt-dlp` binary behind a small spawn helper and a typed-error classifier; `cache/` is an LRU-by-size disk cache with pinning; `queue/` is a pure, mutex-serialized state machine that emits `changed`/`prefetch` events and operates on stable item IDs. Every unit is tested with the subprocess and filesystem isolated (mocked `node:child_process`, temp dirs).

**Tech Stack:** Node 22.12+, TypeScript 6 (NodeNext ESM), Vitest, tsx, ESLint flat config + Prettier. No runtime deps in this plan beyond Node built-ins (Discord/Fastify/voice libs arrive in later plans).

**Companion reference:** [docs/superpowers/research/2026-06-25-verified-api-reference.md](../research/2026-06-25-verified-api-reference.md) — exact, web-verified yt-dlp flags, error strings, and tooling. **Spec:** [docs/superpowers/specs/2026-06-25-discord-yt-music-bot-design.md](../specs/2026-06-25-discord-yt-music-bot-design.md).

## Global Constraints

Copied verbatim from the spec / verified reference. Every task implicitly includes these.

- **Runtime:** Node **22.12+**, `"type": "module"`, TypeScript `module/moduleResolution: NodeNext`. **Relative imports MUST use the `.js` extension** (e.g. `import { parseInput } from "./url-parser.js"`).
- **Strictness:** `tsconfig` `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`. Use `import type` for type-only imports.
- **YouTube video ID:** exactly 11 chars matching `/^[A-Za-z0-9_-]{11}$/`.
- **Exact-link rule:** a YouTube URL resolves to *that* video only; `watch?v=ID&list=...` → the `v` video (never the playlist); a bare playlist URL (no `v`) and any non-YouTube URL are **rejected**. A non-URL is a search query.
- **yt-dlp resolve command:** `yt-dlp -J --no-playlist --no-warnings --no-progress -- <url>`.
- **yt-dlp search command:** `yt-dlp -J --flat-playlist --no-warnings --no-progress -- "ytsearchN:<query>"` — `channel`/`duration` may be null; tolerate it.
- **yt-dlp download command:** `yt-dlp -f 'bestaudio[acodec=opus]/bestaudio/best' --no-playlist --max-filesize <N>M --socket-timeout 30 --retries 3 --no-warnings --no-progress -o '<dir>/%(id)s.%(ext)s' -- <url>` (no `-x`/`--audio-format` → lossless Opus passthrough). There is **no total-time flag** — enforce timeout by killing the process.
- **Subprocess rule:** always `child_process.spawn` with an **args array**, never `shell: true`, never interpolate the URL into a string; always pass `--` before the URL.
- **Default player clients (2026 zero-PO-token path):** `android_vr,web_embedded,tv` via `--extractor-args "youtube:player_client=..."`.
- **Queue invariant:** the *only* operation that pops `current` is `advance()` (called on track-end by the orchestrator in Plan 2). There is no `queue.skip()` — "skip" is the orchestrator stopping the player, which triggers `advance()`. This prevents double-advance.
- **Commits:** conventional-commit messages; commit at the end of every task.

---

## File Structure (Plan 1)

```
discord-yt-music-bot/
├── package.json                 # Task 1
├── tsconfig.json                # Task 1
├── vitest.config.ts             # Task 1
├── eslint.config.js             # Task 1
├── .prettierrc.json             # Task 1
├── .gitignore / .dockerignore   # Task 1
├── src/
│   ├── smoke.test.ts            # Task 1 (deleted at end of Task 2)
│   ├── types/index.ts           # Task 2  — TrackMeta, Requester, QueueItem, LiveStatus
│   ├── config.ts                # Task 2  — loadMediaConfig()
│   ├── util/mutex.ts            # Task 8  — Mutex
│   ├── youtube/
│   │   ├── url-parser.ts        # Task 3  — parseInput()
│   │   ├── errors.ts            # Task 4  — YtError, YtErrorKind, classifyYtdlpError()
│   │   ├── ytdlp.ts             # Task 5  — runYtDlp()
│   │   └── index.ts             # Task 6  — YouTubeService
│   ├── cache/index.ts           # Task 7  — AudioCache
│   └── queue/index.ts           # Task 8  — GuildQueue
└── (tests colocated as *.test.ts next to each module)
```

---

### Task 1: Project scaffold & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.gitignore`, `.dockerignore`
- Test: `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm install` / `npm run typecheck` / `npm test` toolchain for all later tasks.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "discord-yt-music-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12 <23" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint . && prettier --check ."
  },
  "devDependencies": {
    "typescript": "^6.0.0",
    "tsx": "^4.22.0",
    "vitest": "^4.1.0",
    "@types/node": "^22.10.0",
    "eslint": "^9.17.0",
    "@eslint/js": "^9.17.0",
    "typescript-eslint": "^8.18.0",
    "prettier": "^3.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "web", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, ignore files**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], globals: false },
});
```

`eslint.config.js`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "web/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
```

`.prettierrc.json`:
```json
{ "semi": true, "singleQuote": false, "trailingComma": "all", "printWidth": 100 }
```

`.gitignore`:
```
node_modules
dist
web/dist
*.log
.env
coverage
```

`.dockerignore`:
```
node_modules
dist
web/dist
.git
*.log
.env
```

- [ ] **Step 4: Write the smoke test**

`src/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("toolchain smoke test", () => {
  it("runs vitest and TypeScript", () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
```

- [ ] **Step 5: Install and verify the toolchain**

Run: `npm install`
Then: `npm run typecheck`
Expected: no errors (exit 0).
Then: `npm test`
Expected: PASS — `1 passed` (the smoke test).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript/Node 22 project with vitest tooling"
```

---

### Task 2: Shared domain types & media config

**Files:**
- Create: `src/types/index.ts`, `src/config.ts`, `src/config.test.ts`
- Delete: `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LiveStatus`, `TrackMeta`, `RequestSource`, `Requester`, `QueueItem` (used by every later task).
  - `MediaConfig` and `loadMediaConfig(env?): MediaConfig` (used by Tasks 6, 7, 8).

```ts
// Produced type signatures (other tasks rely on these EXACT names):
interface TrackMeta {
  videoId: string; title: string; channel: string;
  durationSec: number | null; isLive: boolean; thumbnailUrl: string | null;
}
interface Requester {
  discordUserId: string; displayName: string; avatarUrl: string;
  source: "discord" | "web";
}
interface QueueItem { id: string; meta: TrackMeta; requester: Requester; addedAt: number; }
interface MediaConfig {
  cacheDir: string; cacheMaxBytes: number; historyMaxItems: number;
  searchResultCount: number; maxTrackDurationSec: number | null;
  ytProxy: string | null; ytCookiesFile: string | null; poTokenProviderUrl: string | null;
  sponsorblockRemove: string | null; playerClients: string; ytdlpTimeoutMs: number;
}
```

- [ ] **Step 1: Write `src/types/index.ts`**

```ts
export type LiveStatus = "not_live" | "is_live" | "is_upcoming" | "was_live" | "post_live";

export interface TrackMeta {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number | null;
  isLive: boolean;
  thumbnailUrl: string | null;
}

export type RequestSource = "discord" | "web";

export interface Requester {
  discordUserId: string;
  displayName: string;
  avatarUrl: string;
  source: RequestSource;
}

export interface QueueItem {
  id: string;
  meta: TrackMeta;
  requester: Requester;
  addedAt: number;
}
```

- [ ] **Step 2: Write the failing config test**

`src/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadMediaConfig } from "./config.js";

describe("loadMediaConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadMediaConfig({});
    expect(c.cacheDir).toBe("/data/cache");
    expect(c.cacheMaxBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(c.searchResultCount).toBe(5);
    expect(c.playerClients).toBe("android_vr,web_embedded,tv");
    expect(c.maxTrackDurationSec).toBeNull();
    expect(c.sponsorblockRemove).toBeNull();
  });

  it("parses overrides from env", () => {
    const c = loadMediaConfig({
      CACHE_DIR: "/tmp/c",
      CACHE_MAX_MB: "100",
      SEARCH_RESULT_COUNT: "3",
      MAX_TRACK_DURATION_SEC: "600",
      SPONSORBLOCK_REMOVE: "sponsor,music_offtopic",
      YT_PROXY: "socks5://127.0.0.1:1080",
    });
    expect(c.cacheDir).toBe("/tmp/c");
    expect(c.cacheMaxBytes).toBe(100 * 1024 * 1024);
    expect(c.searchResultCount).toBe(3);
    expect(c.maxTrackDurationSec).toBe(600);
    expect(c.sponsorblockRemove).toBe("sponsor,music_offtopic");
    expect(c.ytProxy).toBe("socks5://127.0.0.1:1080");
  });

  it("throws on a non-numeric CACHE_MAX_MB", () => {
    expect(() => loadMediaConfig({ CACHE_MAX_MB: "abc" })).toThrow(/CACHE_MAX_MB/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — cannot find module `./config.js`.

- [ ] **Step 4: Write `src/config.ts`**

```ts
import type { MediaConfig } from "./types/config-types.js";

export type { MediaConfig } from "./types/config-types.js";

type Env = Record<string, string | undefined>;

function intEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid ${key}: expected an integer, got "${raw}"`);
  }
  return n;
}

function strEnv(env: Env, key: string): string | null {
  const raw = env[key];
  return raw === undefined || raw === "" ? null : raw;
}

export function loadMediaConfig(env: Env = process.env): MediaConfig {
  const maxDur = strEnv(env, "MAX_TRACK_DURATION_SEC");
  return {
    cacheDir: strEnv(env, "CACHE_DIR") ?? "/data/cache",
    cacheMaxBytes: intEnv(env, "CACHE_MAX_MB", 2048) * 1024 * 1024,
    historyMaxItems: intEnv(env, "HISTORY_MAX_ITEMS", 100),
    searchResultCount: intEnv(env, "SEARCH_RESULT_COUNT", 5),
    maxTrackDurationSec: maxDur === null ? null : intEnv(env, "MAX_TRACK_DURATION_SEC", 0),
    ytProxy: strEnv(env, "YT_PROXY"),
    ytCookiesFile: strEnv(env, "YT_COOKIES"),
    poTokenProviderUrl: strEnv(env, "PO_TOKEN_PROVIDER_URL"),
    sponsorblockRemove: strEnv(env, "SPONSORBLOCK_REMOVE"),
    playerClients: strEnv(env, "YT_PLAYER_CLIENTS") ?? "android_vr,web_embedded,tv",
    ytdlpTimeoutMs: intEnv(env, "YTDLP_TIMEOUT_MS", 60_000),
  };
}
```

Also create `src/types/config-types.ts`:
```ts
export interface MediaConfig {
  cacheDir: string;
  cacheMaxBytes: number;
  historyMaxItems: number;
  searchResultCount: number;
  maxTrackDurationSec: number | null;
  ytProxy: string | null;
  ytCookiesFile: string | null;
  poTokenProviderUrl: string | null;
  sponsorblockRemove: string | null;
  playerClients: string;
  ytdlpTimeoutMs: number;
}
```

- [ ] **Step 5: Delete the smoke test and run the suite**

```bash
rm src/smoke.test.ts
```
Run: `npm test`
Expected: PASS — the 3 config tests pass.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add shared domain types and media config loader"
```

---

### Task 3: YouTube input parser (`parseInput`)

**Files:**
- Create: `src/youtube/url-parser.ts`, `src/youtube/url-parser.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ParsedInput` and `parseInput(raw: string): ParsedInput` (used by Plan 2's command layer and Plan 3's API).

```ts
type ParsedInput =
  | { kind: "video"; videoId: string }
  | { kind: "query"; query: string }
  | { kind: "reject"; reason: string };
```

- [ ] **Step 1: Write the failing tests**

`src/youtube/url-parser.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseInput } from "./url-parser.js";

const ID = "dQw4w9WgXcQ";

describe("parseInput — video URLs", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/watch?v=${ID}&list=PLxxxxxxxx`, // playlist param ignored
  ])("extracts the video id from %s", (url) => {
    expect(parseInput(url)).toEqual({ kind: "video", videoId: ID });
  });
});

describe("parseInput — rejections", () => {
  it("rejects a bare playlist URL with no video", () => {
    const r = parseInput("https://www.youtube.com/playlist?list=PLxxxx");
    expect(r.kind).toBe("reject");
  });
  it("rejects a non-YouTube URL", () => {
    const r = parseInput("https://vimeo.com/12345");
    expect(r).toEqual({ kind: "reject", reason: expect.stringContaining("YouTube") });
  });
  it("rejects an empty string", () => {
    expect(parseInput("   ").kind).toBe("reject");
  });
});

describe("parseInput — queries", () => {
  it("treats plain text as a search query", () => {
    expect(parseInput("daft punk one more time")).toEqual({
      kind: "query",
      query: "daft punk one more time",
    });
  });
  it("trims surrounding whitespace on a query", () => {
    expect(parseInput("  lofi beats  ")).toEqual({ kind: "query", query: "lofi beats" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/youtube/url-parser.test.ts`
Expected: FAIL — cannot find module `./url-parser.js`.

- [ ] **Step 3: Write `src/youtube/url-parser.ts`**

```ts
export type ParsedInput =
  | { kind: "video"; videoId: string }
  | { kind: "query"; query: string }
  | { kind: "reject"; reason: string };

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = new Set(["shorts", "embed", "live", "v"]);

export function parseInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) return { kind: "reject", reason: "empty input" };

  const looksLikeUrl =
    /^https?:\/\//i.test(input) || /^[\w-]+(\.[\w-]+)+\//.test(input);
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/youtube/url-parser.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(youtube): add URL/query parser with canonical video-id extraction"
```

---

### Task 4: yt-dlp typed errors & stderr classifier

**Files:**
- Create: `src/youtube/errors.ts`, `src/youtube/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `enum YtErrorKind`, `class YtError extends Error { kind: YtErrorKind }`, `classifyYtdlpError(stderr: string, code: number | null): YtError` (used by Tasks 5 & 6, and surfaced to users in Plan 2/3).

- [ ] **Step 1: Write the failing tests**

`src/youtube/errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { classifyYtdlpError, YtErrorKind } from "./errors.js";

describe("classifyYtdlpError", () => {
  it.each<[string, YtErrorKind]>([
    ["ERROR: [youtube] xx: Private video. Sign in if you've been granted access", YtErrorKind.Private],
    ["ERROR: Sign in to confirm your age. This video may be inappropriate", YtErrorKind.AgeRestricted],
    ["ERROR: [youtube] xx: Video unavailable. This video has been removed", YtErrorKind.Unavailable],
    ["ERROR: Join this channel to get access to members-only content", YtErrorKind.MembersOnly],
    ["ERROR: The uploader has not made this video available in your country", YtErrorKind.GeoBlocked],
    ["ERROR: Sign in to confirm you're not a bot. Your IP is likely being blocked", YtErrorKind.IpBlocked],
    ["WARNING: Some web client https formats require a GVS PO Token which was not provided", YtErrorKind.PoTokenSabr],
    ["ERROR: Only images are available for download", YtErrorKind.PoTokenSabr],
    ["ERROR: This content isn't available, rate-limited by YouTube for up to an hour", YtErrorKind.RateLimited],
  ])("classifies %s", (stderr, kind) => {
    expect(classifyYtdlpError(stderr, 1).kind).toBe(kind);
  });

  it("prioritizes IP-block over a generic private hint", () => {
    const stderr = "Private video. Sign in to confirm you're not a bot. Your IP is likely being blocked";
    expect(classifyYtdlpError(stderr, 1).kind).toBe(YtErrorKind.IpBlocked);
  });

  it("falls back to Unknown and keeps the raw stderr in the message", () => {
    const e = classifyYtdlpError("ERROR: something totally new", 1);
    expect(e.kind).toBe(YtErrorKind.Unknown);
    expect(e.message).toContain("something totally new");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/youtube/errors.test.ts`
Expected: FAIL — cannot find module `./errors.js`.

- [ ] **Step 3: Write `src/youtube/errors.ts`**

```ts
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
  [YtErrorKind.PoTokenSabr, /po token|only images are available|nsig extraction failed|require a gvs/i],
  [YtErrorKind.MembersOnly, /members-only|channel'?s members|requires payment/i],
  [YtErrorKind.AgeRestricted, /confirm your age|age-restricted|inappropriate/i],
  [YtErrorKind.Private, /private video|this video is private/i],
  [YtErrorKind.GeoBlocked, /available in your country/i],
  [YtErrorKind.RateLimited, /rate-limited|try again later/i],
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/youtube/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(youtube): add typed yt-dlp errors and stderr classifier"
```

---

### Task 5: yt-dlp spawn wrapper (`runYtDlp`)

**Files:**
- Create: `src/youtube/ytdlp.ts`, `src/youtube/ytdlp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface YtDlpRun { stdout: string; stderr: string; code: number | null }` and `runYtDlp(args: string[], timeoutMs: number): Promise<YtDlpRun>` (used by Task 6). Rejects with a `YtError(Timeout)` if the process exceeds `timeoutMs`, and propagates spawn `error` (e.g. ENOENT).

- [ ] **Step 1: Write the failing tests** (mock `node:child_process`)

`src/youtube/ytdlp.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runYtDlp } from "./ytdlp.js";
import { YtErrorKind } from "./errors.js";

type FakeProc = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
};

function fakeProc(stdout: string, stderr: string, code: number | null): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = Readable.from([stdout]);
  proc.stderr = Readable.from([stderr]);
  proc.kill = vi.fn();
  queueMicrotask(() => proc.emit("close", code));
  return proc;
}

describe("runYtDlp", () => {
  beforeEach(() => spawnMock.mockReset());

  it("spawns yt-dlp with the args array and no shell", async () => {
    spawnMock.mockReturnValue(fakeProc('{"ok":true}', "", 0));
    const res = await runYtDlp(["-J", "--", "https://x"], 1000);
    expect(spawnMock).toHaveBeenCalledWith(
      "yt-dlp",
      ["-J", "--", "https://x"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(res).toEqual({ stdout: '{"ok":true}', stderr: "", code: 0 });
  });

  it("rejects with a Timeout YtError and kills the process when it overruns", async () => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new Readable({ read() {} }); // never ends
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);

    const p = runYtDlp(["-J"], 10);
    await expect(p).rejects.toMatchObject({ kind: YtErrorKind.Timeout });
    expect(proc.kill).toHaveBeenCalled();
  });

  it("propagates a spawn error (e.g. ENOENT)", async () => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = Readable.from([]);
    proc.stderr = Readable.from([]);
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);
    const p = runYtDlp(["-J"], 1000);
    queueMicrotask(() => proc.emit("error", new Error("spawn yt-dlp ENOENT")));
    await expect(p).rejects.toThrow(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/youtube/ytdlp.test.ts`
Expected: FAIL — cannot find module `./ytdlp.js`.

- [ ] **Step 3: Write `src/youtube/ytdlp.ts`**

```ts
import { spawn } from "node:child_process";
import { YtError, YtErrorKind } from "./errors.js";

export interface YtDlpRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runYtDlp(args: string[], timeoutMs: number): Promise<YtDlpRun> {
  return new Promise<YtDlpRun>((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new YtError(YtErrorKind.Timeout, `yt-dlp timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/youtube/ytdlp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(youtube): add yt-dlp spawn wrapper with timeout kill"
```

---

### Task 6: YouTube service (`resolve` / `search` / `download`)

**Files:**
- Create: `src/youtube/index.ts`, `src/youtube/index.test.ts`

**Interfaces:**
- Consumes: `MediaConfig` (Task 2), `runYtDlp`/`YtDlpRun` (Task 5), `YtError`/`YtErrorKind`/`classifyYtdlpError` (Task 4), `TrackMeta` (Task 2).
- Produces: `class YouTubeService` with:
  - `resolve(videoId: string): Promise<TrackMeta>` — throws `YtError(Live)` for live, `YtError(TooLong)` over `maxTrackDurationSec`, classified errors on failure.
  - `search(query: string, limit?: number): Promise<TrackMeta[]>` — tolerates null channel/duration.
  - `download(videoId: string, outDir: string): Promise<string>` — returns the produced file path.

The service is constructed with the run function injected so tests mock the wrapper module.

- [ ] **Step 1: Write the failing tests** (mock `./ytdlp.js`)

`src/youtube/index.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("./ytdlp.js", () => ({ runYtDlp: runMock }));

import { YouTubeService } from "./index.js";
import { YtErrorKind } from "./errors.js";
import { loadMediaConfig } from "../config.js";

const cfg = loadMediaConfig({ MAX_TRACK_DURATION_SEC: "3600" });

function ok(stdout: string) {
  return { stdout, stderr: "", code: 0 };
}

describe("YouTubeService.resolve", () => {
  beforeEach(() => runMock.mockReset());

  it("maps yt-dlp -J output to TrackMeta", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({
        id: "dQw4w9WgXcQ", title: "Song", channel: "Chan",
        duration: 200, is_live: false, thumbnail: "http://t",
      })),
    );
    const svc = new YouTubeService(cfg);
    const meta = await svc.resolve("dQw4w9WgXcQ");
    expect(meta).toEqual({
      videoId: "dQw4w9WgXcQ", title: "Song", channel: "Chan",
      durationSec: 200, isLive: false, thumbnailUrl: "http://t",
    });
    // resolve uses -J --no-playlist on the canonical watch URL
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-J");
    expect(args).toContain("--no-playlist");
    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("falls back to uploader and Unknown channel, null duration", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "S", uploader: "Up" })));
    const meta = await new YouTubeService(cfg).resolve("dQw4w9WgXcQ");
    expect(meta.channel).toBe("Up");
    expect(meta.durationSec).toBeNull();
  });

  it("throws Live for a live video", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "L", live_status: "is_live" })));
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Live,
    });
  });

  it("throws TooLong over the duration cap", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "X", duration: 4000 })));
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.TooLong,
    });
  });

  it("classifies a non-zero exit", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: Private video", code: 1 });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Private,
    });
  });
});

describe("YouTubeService.search", () => {
  beforeEach(() => runMock.mockReset());

  it("maps flat entries, tolerating missing channel/duration", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({
        entries: [
          { id: "aaaaaaaaaaa", title: "A", channel: "C", duration: 100 },
          { id: "bbbbbbbbbbb", title: "B" }, // missing channel + duration
        ],
      })),
    );
    const res = await new YouTubeService(cfg).search("q", 2);
    expect(res).toHaveLength(2);
    expect(res[1]).toEqual({
      videoId: "bbbbbbbbbbb", title: "B", channel: "Unknown",
      durationSec: null, isLive: false, thumbnailUrl: null,
    });
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args[args.length - 1]).toBe("ytsearch2:q");
    expect(args).toContain("--flat-playlist");
  });
});

describe("YouTubeService.download", () => {
  beforeEach(() => runMock.mockReset());

  it("returns the produced file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    const path = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("bestaudio[acodec=opus]/bestaudio/best");
    expect(args).toContain("--no-playlist");
  });

  it("throws when yt-dlp succeeds but no file is produced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    runMock.mockResolvedValue(ok(""));
    await expect(new YouTubeService(cfg).download("dQw4w9WgXcQ", dir)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/youtube/index.test.ts`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Write `src/youtube/index.ts`**

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MediaConfig } from "../config.js";
import type { TrackMeta } from "../types/index.js";
import { runYtDlp } from "./ytdlp.js";
import { YtError, YtErrorKind, classifyYtdlpError } from "./errors.js";

type RunFn = typeof runYtDlp;

interface RawInfo {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  thumbnail?: string;
}

function toMeta(j: RawInfo): TrackMeta {
  const isLive = j.is_live === true || j.live_status === "is_live" || j.live_status === "is_upcoming";
  return {
    videoId: j.id,
    title: j.title ?? "Unknown title",
    channel: j.channel ?? j.uploader ?? "Unknown",
    durationSec: typeof j.duration === "number" ? j.duration : null,
    isLive,
    thumbnailUrl: j.thumbnail ?? null,
  };
}

export class YouTubeService {
  constructor(
    private readonly cfg: MediaConfig,
    private readonly run: RunFn = runYtDlp,
  ) {}

  private extractorArgs(): string[] {
    const args = ["--extractor-args", `youtube:player_client=${this.cfg.playerClients}`];
    if (this.cfg.ytProxy) args.push("--proxy", this.cfg.ytProxy);
    if (this.cfg.ytCookiesFile) args.push("--cookies", this.cfg.ytCookiesFile);
    return args;
  }

  async resolve(videoId: string): Promise<TrackMeta> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const { stdout, stderr, code } = await this.run(
      ["-J", "--no-playlist", "--no-warnings", "--no-progress", ...this.extractorArgs(), "--", url],
      this.cfg.ytdlpTimeoutMs,
    );
    if (code !== 0) throw classifyYtdlpError(stderr, code);

    const meta = toMeta(JSON.parse(stdout) as RawInfo);
    if (meta.isLive) throw new YtError(YtErrorKind.Live, "live streams are not supported");
    if (
      this.cfg.maxTrackDurationSec !== null &&
      meta.durationSec !== null &&
      meta.durationSec > this.cfg.maxTrackDurationSec
    ) {
      throw new YtError(
        YtErrorKind.TooLong,
        `track is ${meta.durationSec}s, over the ${this.cfg.maxTrackDurationSec}s limit`,
      );
    }
    return meta;
  }

  async search(query: string, limit = this.cfg.searchResultCount): Promise<TrackMeta[]> {
    const { stdout, stderr, code } = await this.run(
      ["-J", "--flat-playlist", "--no-warnings", "--no-progress", "--", `ytsearch${limit}:${query}`],
      this.cfg.ytdlpTimeoutMs,
    );
    if (code !== 0) throw classifyYtdlpError(stderr, code);

    const parsed = JSON.parse(stdout) as { entries?: RawInfo[] };
    return (parsed.entries ?? []).map(toMeta);
  }

  async download(videoId: string, outDir: string): Promise<string> {
    const maxMb = Math.floor(this.cfg.cacheMaxBytes / (1024 * 1024));
    const args = [
      "-f", "bestaudio[acodec=opus]/bestaudio/best",
      "--no-playlist",
      "--max-filesize", `${Math.max(1, Math.min(maxMb, 500))}M`,
      "--socket-timeout", "30",
      "--retries", "3",
      "--no-warnings", "--no-progress",
      ...this.extractorArgs(),
    ];
    if (this.cfg.sponsorblockRemove) {
      args.push("-x", "--audio-format", "opus", "--sponsorblock-remove", this.cfg.sponsorblockRemove);
    }
    args.push("-o", join(outDir, "%(id)s.%(ext)s"), "--", `https://www.youtube.com/watch?v=${videoId}`);

    const { stderr, code } = await this.run(args, this.cfg.ytdlpTimeoutMs);
    if (code !== 0) throw classifyYtdlpError(stderr, code);

    const files = await readdir(outDir);
    const produced = files.find((f) => f.startsWith(`${videoId}.`));
    if (!produced) {
      throw new YtError(YtErrorKind.Unknown, `download completed but no file for ${videoId} was found`);
    }
    return join(outDir, produced);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/youtube/index.test.ts`
Expected: PASS — all resolve/search/download cases green.

- [ ] **Step 5: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(youtube): add YouTubeService (resolve/search/download)"
```

---

### Task 7: On-disk audio cache (`AudioCache`)

**Files:**
- Create: `src/cache/index.ts`, `src/cache/index.test.ts`

**Interfaces:**
- Consumes: nothing (takes a dir + maxBytes; Plan 2 wires in `MediaConfig.cacheDir`/`cacheMaxBytes`).
- Produces: `class AudioCache` with `init()`, `register(videoId, filePath)`, `get(videoId): string | null`, `has(videoId): boolean`, `pin(videoId)`, `unpin(videoId)`, `totalBytes(): number`. LRU eviction by total size; **pinned entries are never evicted**. Ordering uses a monotonic counter (no wall-clock) for deterministic tests.

- [ ] **Step 1: Write the failing tests**

`src/cache/index.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioCache } from "./index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cache-"));
});

async function makeFile(name: string, bytes: number): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, Buffer.alloc(bytes));
  return p;
}

describe("AudioCache", () => {
  it("registers and retrieves a file, tracking total bytes", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    const p = await makeFile("aaaaaaaaaaa.webm", 300);
    cache.register("aaaaaaaaaaa", p);
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.get("aaaaaaaaaaa")).toBe(p);
    expect(cache.totalBytes()).toBe(300);
  });

  it("evicts the least-recently-used file when over the cap", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300)); // total 600 > 500
    // 'a' is LRU and should be evicted from disk + index.
    expect(cache.has("aaaaaaaaaaa")).toBe(false);
    expect(existsSync(join(dir, "aaaaaaaaaaa.webm"))).toBe(false);
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
  });

  it("get() refreshes recency so the other entry is evicted next", async () => {
    const cache = new AudioCache(dir, 650);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300));
    cache.get("aaaaaaaaaaa"); // touch 'a' → 'b' now LRU
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm", 300)); // 900 > 650
    expect(cache.has("bbbbbbbbbbb")).toBe(false);
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
  });

  it("never evicts a pinned entry, even if it is LRU", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.pin("aaaaaaaaaaa");
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300)); // 600 > 500
    expect(cache.has("aaaaaaaaaaa")).toBe(true); // pinned survives
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
    cache.unpin("aaaaaaaaaaa");
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm", 300));
    expect(cache.has("aaaaaaaaaaa")).toBe(false); // now evictable
  });

  it("get() returns null for an unknown id", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    expect(cache.get("zzzzzzzzzzz")).toBeNull();
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
import { afterEach } from "vitest";
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/cache/index.test.ts`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 3: Write `src/cache/index.ts`**

```ts
import { mkdir, rm, stat } from "node:fs/promises";

interface CacheEntry {
  videoId: string;
  filePath: string;
  sizeBytes: number;
  lastUsed: number;
  pinned: boolean;
}

export class AudioCache {
  private readonly entries = new Map<string, CacheEntry>();
  private clock = 0;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  has(videoId: string): boolean {
    return this.entries.has(videoId);
  }

  get(videoId: string): string | null {
    const e = this.entries.get(videoId);
    if (!e) return null;
    e.lastUsed = ++this.clock;
    return e.filePath;
  }

  register(videoId: string, filePath: string): void {
    const { size } = statSyncSafe(filePath);
    this.entries.set(videoId, {
      videoId,
      filePath,
      sizeBytes: size,
      lastUsed: ++this.clock,
      pinned: this.entries.get(videoId)?.pinned ?? false,
    });
    void this.evict();
  }

  pin(videoId: string): void {
    const e = this.entries.get(videoId);
    if (e) e.pinned = true;
  }

  unpin(videoId: string): void {
    const e = this.entries.get(videoId);
    if (e) e.pinned = false;
  }

  totalBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.sizeBytes;
    return total;
  }

  private async evict(): Promise<void> {
    while (this.totalBytes() > this.maxBytes) {
      let victim: CacheEntry | null = null;
      for (const e of this.entries.values()) {
        if (e.pinned) continue;
        if (victim === null || e.lastUsed < victim.lastUsed) victim = e;
      }
      if (victim === null) return; // everything left is pinned
      this.entries.delete(victim.videoId);
      await rm(victim.filePath, { force: true });
    }
  }
}

// statSync via the promise API is awkward in register() (sync needed before evict bookkeeping);
// use a tiny sync helper so register stays synchronous for callers.
import { statSync } from "node:fs";
function statSyncSafe(filePath: string): { size: number } {
  try {
    return { size: statSync(filePath).size };
  } catch {
    return { size: 0 };
  }
}
void stat; // keep the async import available for future async stat use
```

> Note: `register()` is synchronous (uses `statSync`) so callers don't have to await bookkeeping; eviction runs async via `void this.evict()` and only does filesystem `rm`. The unused `stat` async import is dropped if the linter complains — remove the `import { stat }` and the `void stat;` line in that case.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/cache/index.test.ts`
Expected: PASS — registration, LRU eviction, recency refresh, and pinning all green.

- [ ] **Step 5: Tidy lint (remove the unused async `stat` import if flagged)**

Run: `npm run lint`
If ESLint flags `stat`/`void stat`, delete `stat` from the `node:fs/promises` import and remove the `void stat;` line, then re-run `npm test`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cache): add LRU-by-size disk audio cache with pinning"
```

---

### Task 8: Mutex utility + pure per-guild queue (`GuildQueue`)

**Files:**
- Create: `src/util/mutex.ts`, `src/util/mutex.test.ts`, `src/queue/index.ts`, `src/queue/index.test.ts`

**Interfaces:**
- Consumes: `TrackMeta`, `Requester`, `QueueItem` (Task 2).
- Produces:
  - `class Mutex { runExclusive<T>(fn: () => Promise<T> | T): Promise<T> }` (reused by orchestrator/voice in Plan 2).
  - `class GuildQueue extends EventEmitter` — events `"changed"` (passes a snapshot) and `"prefetch"` (passes `string | null`, the next videoId). Async, mutex-serialized methods: `add(meta, requester) → Promise<QueueItem>`, `advance() → Promise<QueueItem | null>`, `remove(itemId) → Promise<boolean>`, `reorder(itemId, toIndex) → Promise<boolean>`, `clear() → Promise<void>`. Sync reads: `get current()`, `snapshot()`. Options: `{ historyMax?, idFactory?, now? }`.

- [ ] **Step 1: Write the failing mutex test**

`src/util/mutex.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Mutex } from "./mutex.js";

describe("Mutex", () => {
  it("serializes overlapping critical sections", async () => {
    const m = new Mutex();
    const log: string[] = [];
    async function section(tag: string) {
      await m.runExclusive(async () => {
        log.push(`${tag}-start`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`${tag}-end`);
      });
    }
    await Promise.all([section("a"), section("b")]);
    // No interleaving: each start is immediately followed by its own end.
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("returns the callback result and continues after a throw", async () => {
    const m = new Mutex();
    await expect(m.runExclusive(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(m.runExclusive(() => 42)).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write `src/util/mutex.ts`**

Run: `npx vitest run src/util/mutex.test.ts` → FAIL (no module).

```ts
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => fn());
    // Keep the chain alive even if fn rejects, so the lock always releases.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

Run: `npx vitest run src/util/mutex.test.ts` → PASS.

- [ ] **Step 3: Write the failing queue tests**

`src/queue/index.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { GuildQueue } from "./index.js";
import type { Requester, TrackMeta } from "../types/index.js";

const requester: Requester = {
  discordUserId: "1", displayName: "u", avatarUrl: "http://a", source: "discord",
};
function meta(videoId: string): TrackMeta {
  return { videoId, title: videoId, channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null };
}
function newQueue() {
  let n = 0;
  return new GuildQueue({ historyMax: 2, idFactory: () => `id${++n}`, now: () => 0 });
}

describe("GuildQueue", () => {
  it("adds to upcoming and emits changed + prefetch", async () => {
    const q = newQueue();
    const changed = vi.fn();
    const prefetch = vi.fn();
    q.on("changed", changed);
    q.on("prefetch", prefetch);

    const item = await q.add(meta("aaaaaaaaaaa"), requester);
    expect(item.id).toBe("id1");
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1"]);
    expect(q.current).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenLastCalledWith("aaaaaaaaaaa");
  });

  it("advance() promotes the head and moves the old current to history", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);

    const first = await q.advance();
    expect(first?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(q.current?.meta.videoId).toBe("aaaaaaaaaaa");

    const second = await q.advance();
    expect(second?.meta.videoId).toBe("bbbbbbbbbbb");
    expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["aaaaaaaaaaa"]);

    const none = await q.advance();
    expect(none).toBeNull();
    expect(q.current).toBeNull();
  });

  it("bounds history to historyMax (ring buffer)", async () => {
    const q = newQueue(); // historyMax 2
    for (const v of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]) {
      await q.add(meta(v), requester);
    }
    await q.advance();
    await q.advance();
    await q.advance();
    await q.advance(); // 3 items have rolled into history, capped at 2
    expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("removes an upcoming item by id", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    const b = await q.add(meta("bbbbbbbbbbb"), requester);
    expect(await q.remove(b.id)).toBe(true);
    expect(await q.remove("nope")).toBe(false);
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1"]);
  });

  it("reorders an upcoming item to a new index", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    const c = await q.add(meta("ccccccccccc"), requester);
    expect(await q.reorder(c.id, 0)).toBe(true);
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
      "ccccccccccc", "aaaaaaaaaaa", "bbbbbbbbbbb",
    ]);
  });

  it("clear() empties current and upcoming but keeps history", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.advance();
    await q.add(meta("bbbbbbbbbbb"), requester);
    await q.clear();
    expect(q.current).toBeNull();
    expect(q.snapshot().upcoming).toEqual([]);
  });

  it("serializes concurrent adds without losing or duplicating items", async () => {
    const q = newQueue();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        q.add(meta(`v${String(i).padStart(10, "0")}`), requester),
      ),
    );
    const ids = q.snapshot().upcoming.map((i) => i.id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50); // all unique, none lost
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run src/queue/index.test.ts`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 5: Write `src/queue/index.ts`**

```ts
import { EventEmitter } from "node:events";
import type { QueueItem, Requester, TrackMeta } from "../types/index.js";
import { Mutex } from "../util/mutex.js";

export interface QueueSnapshot {
  current: QueueItem | null;
  upcoming: QueueItem[];
  history: QueueItem[];
}

export interface GuildQueueOptions {
  historyMax?: number;
  idFactory?: () => string;
  now?: () => number;
}

export class GuildQueue extends EventEmitter {
  private _current: QueueItem | null = null;
  private _upcoming: QueueItem[] = [];
  private _history: QueueItem[] = [];
  private readonly mutex = new Mutex();
  private readonly historyMax: number;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(opts: GuildQueueOptions = {}) {
    super();
    this.historyMax = opts.historyMax ?? 100;
    this.idFactory = opts.idFactory ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => Date.now());
  }

  get current(): QueueItem | null {
    return this._current;
  }

  snapshot(): QueueSnapshot {
    return {
      current: this._current,
      upcoming: [...this._upcoming],
      history: [...this._history],
    };
  }

  add(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
    return this.mutex.runExclusive(() => {
      const item: QueueItem = { id: this.idFactory(), meta, requester, addedAt: this.now() };
      this._upcoming.push(item);
      this.emitChange();
      return item;
    });
  }

  advance(): Promise<QueueItem | null> {
    return this.mutex.runExclusive(() => {
      if (this._current) {
        this._history.push(this._current);
        if (this._history.length > this.historyMax) {
          this._history.splice(0, this._history.length - this.historyMax);
        }
      }
      this._current = this._upcoming.shift() ?? null;
      this.emitChange();
      return this._current;
    });
  }

  remove(itemId: string): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const idx = this._upcoming.findIndex((i) => i.id === itemId);
      if (idx === -1) return false;
      this._upcoming.splice(idx, 1);
      this.emitChange();
      return true;
    });
  }

  reorder(itemId: string, toIndex: number): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const from = this._upcoming.findIndex((i) => i.id === itemId);
      if (from === -1) return false;
      const clamped = Math.max(0, Math.min(toIndex, this._upcoming.length - 1));
      const [item] = this._upcoming.splice(from, 1);
      if (item) this._upcoming.splice(clamped, 0, item);
      this.emitChange();
      return true;
    });
  }

  clear(): Promise<void> {
    return this.mutex.runExclusive(() => {
      this._current = null;
      this._upcoming = [];
      this.emitChange();
    });
  }

  private emitChange(): void {
    this.emit("changed", this.snapshot());
    this.emit("prefetch", this._upcoming[0]?.meta.videoId ?? null);
  }
}
```

- [ ] **Step 6: Run to verify it passes + full suite + typecheck + lint**

Run: `npx vitest run src/queue/index.test.ts`
Expected: PASS — including the concurrent-add serialization test.
Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(queue): add Mutex util and pure mutex-serialized GuildQueue"
```

---

## Self-Review

**1. Spec coverage (Plan 1 scope = backend core):**
- §3 exact-link rule + §3.1 URL forms → Task 3 ✔ (watch/youtu.be/shorts/embed/live/music/m, `&t`/`&si` ignored, `watch?v&list` → video, bare playlist rejected, non-YT rejected).
- §4 `youtube/` (resolve/search/download) → Tasks 4–6 ✔; `cache/` LRU + pin → Task 7 ✔; pure `queue/` mutex + stable ids + `changed`/`prefetch` + bounded history → Task 8 ✔.
- §5 download flags (`bestaudio[acodec=opus]/bestaudio/best`, `--no-playlist`, player_client, proxy/cookies, optional SponsorBlock) → Task 6 ✔. Live rejection + duration cap → Task 6 ✔.
- §11 typed errors (private/age/unavailable/members/geo/ip-block/po-token-sabr/rate-limit/timeout/too-long) → Tasks 4–6 ✔.
- §13 config (cache, history, search count, duration, proxy/cookies/po-token, sponsorblock, player clients, timeout) → Task 2 ✔.
- §12 testing (parser, queue incl. concurrency, youtube w/ mocked subprocess, cache eviction) → Tasks 3,6,7,8 ✔.
- **Deferred to later plans (correctly out of Plan 1 scope):** voice/DAVE, orchestrator, Discord command layer (Plan 2); OAuth/sessions/REST/WS (Plan 3); frontend (Plan 4); Dockerfile/compose/CI/healthz/graceful-shutdown/active-session-snapshot (Plan 2/3 + deployment). The verified reference doc already holds their exact APIs.

**2. Placeholder scan:** none — every step has runnable code/commands. The only conditional is Task 7 Step 5 (remove an unused import if the linter flags it), which is explicit.

**3. Type consistency:** `TrackMeta`/`Requester`/`QueueItem`/`MediaConfig` defined in Task 2 and consumed verbatim in Tasks 6 & 8. `runYtDlp`/`YtDlpRun` (Task 5) consumed in Task 6. `YtError`/`YtErrorKind`/`classifyYtdlpError` (Task 4) consumed in Tasks 5 & 6. `Mutex.runExclusive` (Task 8) used by `GuildQueue` (Task 8). Method names match across tasks (`resolve`/`search`/`download`, `add`/`advance`/`remove`/`reorder`/`clear`, `register`/`get`/`pin`/`unpin`). No `skip()` on the queue — consistent with the Global Constraint that only `advance()` pops `current`.

Plan 1 is complete and internally consistent.
