# discord-yt-music-bot — Plan 2: Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Plan 1 backend core into a working Discord music bot — join a voice channel, play the queued YouTube audio (Opus passthrough, DAVE-encrypted), respond to `?`-prefixed commands, and let a song-name search be resolved by a button picker.

**Architecture:** Three new layers over Plan 1. `voice/` wraps `@discordjs/voice` behind a small, injectable `VoiceSession` state machine (testable with fakes; the real `joinVoiceChannel`/`createAudioResource` glue is isolated in one factory file). `orchestrator/` is the per-guild `GuildController` that wires the pure `GuildQueue` events to the `VoiceSession`, `YouTubeService`, and `AudioCache` (download → cache → pin → play, with a download concurrency cap), plus a `GuildHub` registry. `discord/` is the gateway client: a pure command parser, a button search picker, command handlers, and the thin `Client` wiring.

**Tech Stack:** Plan 1 stack + `discord.js@^14`, `@discordjs/voice@^0.19.2`, `@discordjs/opus@^0.10`, `@noble/ciphers@^1`, `prism-media@^1`. (All verified to install + load on Node 20 in this sandbox; `@discordjs/opus` uses a prebuilt binary.)

**Companion reference:** [docs/superpowers/research/2026-06-25-verified-api-reference.md](../research/2026-06-25-verified-api-reference.md) §2 (discord.js voice). **Spec:** [the design spec](../specs/2026-06-25-discord-yt-music-bot-design.md) §4 (voice/orchestrator/discord), §5.2–5.4 (audio/DAVE), §6 (commands + voice-channel selection).

**Consumes from Plan 1 (exact signatures):**
- `parseInput(raw): {kind:"video",videoId}|{kind:"query",query}|{kind:"reject",reason}` — `src/youtube/url-parser.ts`
- `YouTubeService` (`resolve(videoId)→TrackMeta`, `search(query,limit?)→TrackMeta[]`, `download(videoId,outDir)→string`) — `src/youtube/index.ts`
- `AudioCache` (`init()`, `register(id,path)`, `get(id)→string|null`, `has(id)`, `pin(id)`, `unpin(id)`) — `src/cache/index.ts`
- `GuildQueue` (`add(meta,requester)→QueueItem`, `advance()→QueueItem|null`, `remove(itemId)→boolean`, `reorder`, `clear()`, `get current`, `snapshot()`, events `"changed"`/`"prefetch"`) — `src/queue/index.ts`
- `Mutex` — `src/util/mutex.ts`
- Types `TrackMeta`, `Requester`, `QueueItem`, `MediaConfig`, `loadMediaConfig` — `src/types/`, `src/config.ts`
- `YtError`, `YtErrorKind` — `src/youtube/errors.ts`

## Global Constraints

- **Runtime:** Node 22.12+ target (`@discordjs/voice` floor), `"type":"module"`, NodeNext — **relative imports use `.js`**. Strict TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). No `"DOM"` in tsconfig.
- **Versions (verified):** `@discordjs/voice@^0.19.2` (DAVE E2EE auto via bundled `@snazzah/davey`; <0.19.1 cannot join voice). Encryption lib `@noble/ciphers` (pure JS). `@discordjs/opus` only on the transcode-fallback path. Legacy xsalsa20 is gone — do not reference it.
- **Intents:** `Guilds`, `GuildVoiceStates`, `GuildMessages`, `MessageContent` (privileged). `MessageContent` is required to read `?` commands.
- **Audio:** prefer **Opus passthrough** — build resources with `demuxProbe(createReadStream(file))` → `createAudioResource(stream,{inputType:probe.type, inlineVolume:false, metadata})`. On passthrough there is **no `resource.encoder`** — never call `setBitrate` on it.
- **Voice connect:** `joinVoiceChannel({channelId, guildId, adapterCreator: guild.voiceAdapterCreator})` then `await entersState(connection, VoiceConnectionStatus.Ready, 30_000)`. Subscribe a `createAudioPlayer({behaviors:{noSubscriber: NoSubscriberBehavior.Pause}})`.
- **Track-end signal:** player `stateChange` where `old.status !== Idle && new.status === Idle`.
- **Queue invariant (from Plan 1):** only `queue.advance()` pops `current`. "skip" = `player.stop()` → trackEnd → `advance()` → play next. Never call `advance()` directly on a user skip.
- **Buttons:** picker uses `ButtonBuilder` with `customId = "pick:<videoId>"`; no extra intent. Attribution = `interaction.user`.
- **Exact-link rule:** a URL plays that exact video; a query goes to search+picker; the bot never auto-selects.
- **Testability rule:** real Discord gateway / voice / audio is **manual-verify** (no token/audio in CI). Every other unit is tested with `@discordjs/voice` + `discord.js` mocked or with injected fakes. Mark manual-only files explicitly.
- **Commits:** conventional messages; commit at the end of each task. (Branch `plan-2-playback`; squash-merge to master at the end.)

---

## File Structure (Plan 2)

```
src/
├── config.ts                     # Task 1 — extend with loadBotConfig()
├── util/semaphore.ts             # Task 1 — concurrency limiter (+ test)
├── discord/
│   ├── command-parser.ts         # Task 2 — parseCommand() (pure, +test)
│   ├── picker.ts                 # Task 6 — buildPicker()/decodePick() (+test)
│   ├── handlers.ts               # Task 7 — handleCommand() (+test)
│   └── bot.ts                    # Task 8 — createBot() wiring (glue, structural test)
├── orchestrator/
│   ├── voice-selection.ts        # Task 3 — selectVoiceChannel() (pure, +test)
│   ├── index.ts                  # Task 5 — GuildController (+test)
│   └── hub.ts                    # Task 6 — GuildHub registry (+test)
├── voice/
│   ├── session.ts                # Task 4 — VoiceSession state machine (+test)
│   └── connect.ts                # Task 4 — real joinVoiceChannel/resource factory (glue, manual)
└── index.ts                      # Task 8 — entrypoint (load config → services → bot.login)
README.md                         # Task 8 — Discord application setup guide
```

---

### Task 1: Dependencies, bot config, semaphore

**Files:**
- Modify: `package.json` (add deps), `src/config.ts` (add `loadBotConfig`), `src/types/config-types.ts` (add `BotConfig`)
- Create: `src/util/semaphore.ts`, `src/util/semaphore.test.ts`, `src/config.bot.test.ts`

**Interfaces:**
- Produces: `BotConfig { discordToken, commandPrefix, idleTimeoutMs, prefetchDepth, maxConcurrentDownloads, adminUserIds: string[] }`; `loadBotConfig(env?): BotConfig`; `class Semaphore { constructor(max); run<T>(fn): Promise<T> }`.

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install discord.js@^14 @discordjs/voice@^0.19.2 @discordjs/opus@^0.10 @noble/ciphers@^1 prism-media@^1
```
Expected: installs (an `EBADENGINE` warning for Node 20 is expected and fine).

- [ ] **Step 2: Write the failing semaphore test**

`src/util/semaphore.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("never runs more than `max` tasks concurrently", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("returns the task result and releases a slot after a throw", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(sem.run(() => Promise.resolve(7))).resolves.toBe(7);
  });
});
```

- [ ] **Step 3: Run it (RED), then implement `src/util/semaphore.ts`**

Run: `npx vitest run src/util/semaphore.test.ts` → FAIL (no module).

```ts
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the slot directly to the next waiter (active stays the same)
    } else {
      this.active--;
    }
  }
}
```
Run: `npx vitest run src/util/semaphore.test.ts` → PASS.

- [ ] **Step 4: Add `BotConfig` type and `loadBotConfig`**

Append to `src/types/config-types.ts`:
```ts
export interface BotConfig {
  discordToken: string;
  commandPrefix: string;
  idleTimeoutMs: number;
  prefetchDepth: number;
  maxConcurrentDownloads: number;
  adminUserIds: string[];
}
```

Add to `src/config.ts` (reuse the existing `intEnv`/`strEnv` helpers; export `BotConfig`):
```ts
export type { BotConfig } from "./types/config-types.js";
import type { BotConfig } from "./types/config-types.js";

const SNOWFLAKE = /^\d{17,20}$/;

export function loadBotConfig(env: Env = process.env): BotConfig {
  const token = strEnv(env, "DISCORD_TOKEN");
  if (token === null) throw new Error("DISCORD_TOKEN is required");
  return {
    discordToken: token,
    commandPrefix: strEnv(env, "COMMAND_PREFIX") ?? "?",
    idleTimeoutMs: intEnv(env, "IDLE_TIMEOUT_SEC", 300) * 1000,
    prefetchDepth: intEnv(env, "PREFETCH_DEPTH", 1),
    maxConcurrentDownloads: intEnv(env, "MAX_TRANSCODE_JOBS", 2),
    adminUserIds: (strEnv(env, "ADMIN_USER_IDS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => SNOWFLAKE.test(s)),
  };
}
```
> Note: `intEnv`/`strEnv`/`Env` already exist in `config.ts` from Plan 1. If they are not exported within the module scope, they are still in-file and usable directly — do not duplicate them.

- [ ] **Step 5: Write `src/config.bot.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadBotConfig } from "./config.js";

describe("loadBotConfig", () => {
  it("requires DISCORD_TOKEN", () => {
    expect(() => loadBotConfig({})).toThrow(/DISCORD_TOKEN/);
  });
  it("applies defaults", () => {
    const c = loadBotConfig({ DISCORD_TOKEN: "t" });
    expect(c.commandPrefix).toBe("?");
    expect(c.idleTimeoutMs).toBe(300_000);
    expect(c.prefetchDepth).toBe(1);
    expect(c.maxConcurrentDownloads).toBe(2);
    expect(c.adminUserIds).toEqual([]);
  });
  it("parses admin ids (strict snowflakes, junk dropped)", () => {
    const c = loadBotConfig({
      DISCORD_TOKEN: "t",
      ADMIN_USER_IDS: "123456789012345678, 999, 234567890123456789",
    });
    expect(c.adminUserIds).toEqual(["123456789012345678", "234567890123456789"]);
  });
});
```

- [ ] **Step 6: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint` → all green.
```bash
git add -A
git commit -m "feat(config): add discord deps, BotConfig loader, and Semaphore util"
```

---

### Task 2: Command parser

**Files:** Create `src/discord/command-parser.ts`, `src/discord/command-parser.test.ts`

**Interfaces:**
- Produces: `type Command` and `parseCommand(content: string, prefix?: string): Command`.

```ts
type Command =
  | { kind: "play"; input: string }
  | { kind: "skip" } | { kind: "pause" } | { kind: "resume" } | { kind: "stop" }
  | { kind: "queue" } | { kind: "np" } | { kind: "help" }
  | { kind: "remove"; index: number }
  | { kind: "none" };   // not a command (no prefix) or empty
```

Rules: not prefixed → `none`. After stripping the prefix, the first token is the keyword. Keywords `skip/pause/resume/stop/queue/np/help` map directly; `remove <n>` parses a 1-based integer (invalid/missing → `help`). `play <rest>` and **any non-keyword remainder** (e.g. `?<url>` or `?daft punk`) → `{play, input}`. Bare prefix or `?play` with no input → `help`.

- [ ] **Step 1: Write the failing tests**

`src/discord/command-parser.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseCommand } from "./command-parser.js";

describe("parseCommand", () => {
  it("returns none without the prefix", () => {
    expect(parseCommand("hello")).toEqual({ kind: "none" });
  });
  it("parses control keywords", () => {
    expect(parseCommand("?skip")).toEqual({ kind: "skip" });
    expect(parseCommand("?pause")).toEqual({ kind: "pause" });
    expect(parseCommand("?resume")).toEqual({ kind: "resume" });
    expect(parseCommand("?stop")).toEqual({ kind: "stop" });
    expect(parseCommand("?queue")).toEqual({ kind: "queue" });
    expect(parseCommand("?np")).toEqual({ kind: "np" });
    expect(parseCommand("?help")).toEqual({ kind: "help" });
  });
  it("parses `play <input>` and bare `?<url|query>`", () => {
    expect(parseCommand("?play https://youtu.be/x")).toEqual({ kind: "play", input: "https://youtu.be/x" });
    expect(parseCommand("?https://youtu.be/x")).toEqual({ kind: "play", input: "https://youtu.be/x" });
    expect(parseCommand("?daft punk one more time")).toEqual({ kind: "play", input: "daft punk one more time" });
  });
  it("parses remove with a 1-based index", () => {
    expect(parseCommand("?remove 3")).toEqual({ kind: "remove", index: 3 });
    expect(parseCommand("?remove")).toEqual({ kind: "help" });
    expect(parseCommand("?remove abc")).toEqual({ kind: "help" });
  });
  it("bare prefix or empty play falls back to help", () => {
    expect(parseCommand("?")).toEqual({ kind: "help" });
    expect(parseCommand("?play")).toEqual({ kind: "help" });
  });
  it("respects a custom prefix", () => {
    expect(parseCommand("!skip", "!")).toEqual({ kind: "skip" });
    expect(parseCommand("?skip", "!")).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run (RED), then implement `src/discord/command-parser.ts`**

Run: `npx vitest run src/discord/command-parser.test.ts` → FAIL.

```ts
export type Command =
  | { kind: "play"; input: string }
  | { kind: "skip" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "queue" }
  | { kind: "np" }
  | { kind: "help" }
  | { kind: "remove"; index: number }
  | { kind: "none" };

const CONTROL = new Set(["skip", "pause", "resume", "stop", "queue", "np", "help"]);

export function parseCommand(content: string, prefix = "?"): Command {
  if (!content.startsWith(prefix)) return { kind: "none" };
  const body = content.slice(prefix.length).trim();
  if (!body) return { kind: "help" };

  const spaceIdx = body.indexOf(" ");
  const keyword = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();

  if (CONTROL.has(keyword)) return { kind: keyword as Exclude<Command["kind"], "play" | "remove" | "none"> };
  if (keyword === "remove") {
    const n = Number(rest);
    return Number.isInteger(n) && n >= 1 ? { kind: "remove", index: n } : { kind: "help" };
  }
  if (keyword === "play") return rest ? { kind: "play", input: rest } : { kind: "help" };
  // bare `?<url|query>` → play the whole body
  return { kind: "play", input: body };
}
```

- [ ] **Step 3: Run (GREEN) + commit**

Run: `npx vitest run src/discord/command-parser.test.ts` → PASS. Then `npm run typecheck`.
```bash
git add -A && git commit -m "feat(discord): add ?-command parser"
```

---

### Task 3: Voice-channel selection

**Files:** Create `src/orchestrator/voice-selection.ts`, `src/orchestrator/voice-selection.test.ts`

**Interfaces:**
- Produces: `selectVoiceChannel(ctx): { ok:true; channelId:string; move:boolean } | { ok:false; reason:string }`.

```ts
interface SelectionContext {
  requesterChannelId: string | null; // requester's current voice channel
  botChannelId: string | null;       // bot's current voice channel in this guild
  isAdmin: boolean;
}
```
Rules: requester not in a channel → `{ok:false}`. Bot not connected → join requester's (`move:false`). Bot already in requester's channel → ok same (`move:false`). Bot in a different channel → admin may move (`move:true`); non-admin → `{ok:false, reason: already playing elsewhere}`.

- [ ] **Step 1: Write the failing tests**

`src/orchestrator/voice-selection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { selectVoiceChannel } from "./voice-selection.js";

describe("selectVoiceChannel", () => {
  it("rejects when the requester is not in a voice channel", () => {
    const r = selectVoiceChannel({ requesterChannelId: null, botChannelId: null, isAdmin: false });
    expect(r.ok).toBe(false);
  });
  it("joins the requester's channel when the bot is not connected", () => {
    expect(selectVoiceChannel({ requesterChannelId: "A", botChannelId: null, isAdmin: false }))
      .toEqual({ ok: true, channelId: "A", move: false });
  });
  it("is a no-op when the bot is already in the requester's channel", () => {
    expect(selectVoiceChannel({ requesterChannelId: "A", botChannelId: "A", isAdmin: false }))
      .toEqual({ ok: true, channelId: "A", move: false });
  });
  it("rejects a non-admin when the bot is busy in another channel", () => {
    const r = selectVoiceChannel({ requesterChannelId: "A", botChannelId: "B", isAdmin: false });
    expect(r.ok).toBe(false);
  });
  it("lets an admin move the bot to their channel", () => {
    expect(selectVoiceChannel({ requesterChannelId: "A", botChannelId: "B", isAdmin: true }))
      .toEqual({ ok: true, channelId: "A", move: true });
  });
});
```

- [ ] **Step 2: Run (RED), then implement `src/orchestrator/voice-selection.ts`**

```ts
export interface SelectionContext {
  requesterChannelId: string | null;
  botChannelId: string | null;
  isAdmin: boolean;
}
export type VoiceTarget =
  | { ok: true; channelId: string; move: boolean }
  | { ok: false; reason: string };

export function selectVoiceChannel(ctx: SelectionContext): VoiceTarget {
  if (!ctx.requesterChannelId) {
    return { ok: false, reason: "Join a voice channel first." };
  }
  if (!ctx.botChannelId || ctx.botChannelId === ctx.requesterChannelId) {
    return { ok: true, channelId: ctx.requesterChannelId, move: false };
  }
  if (ctx.isAdmin) {
    return { ok: true, channelId: ctx.requesterChannelId, move: true };
  }
  return { ok: false, reason: "I'm already playing in another channel." };
}
```
Run: `npx vitest run src/orchestrator/voice-selection.test.ts` → PASS.

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "feat(orchestrator): add voice-channel selection logic"
```

---

### Task 4: VoiceSession state machine + real voice factory

**Files:** Create `src/voice/session.ts`, `src/voice/session.test.ts`, `src/voice/connect.ts` (glue, manual-verify)

**Interfaces:**
- Produces:
  - Minimal structural interfaces `VoicePlayerLike`, `VoiceConnectionLike` (the subset of `@discordjs/voice` we use, so the session is fakeable).
  - `class VoiceSession extends EventEmitter` — events `"trackEnd"`, `"error"` (passes the error), `"idle"`. Methods `play(resource)`, `pause()`, `resume()`, `skip()`, `stop()`, `startIdleTimer()`, `cancelIdleTimer()`, `destroy()`, `get channelId()`.
  - `createVoiceSession(channel, idleTimeoutMs): Promise<VoiceSession>` and `createPassthroughResource(filePath, metadata): Promise<AudioResource>` in `connect.ts` (real `@discordjs/voice`; manual-verify).

- [ ] **Step 1: Write the failing tests** (fakes + injected timers)

`src/voice/session.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { VoiceSession } from "./session.js";

// Fakes mirroring the subset of @discordjs/voice we use.
class FakePlayer extends EventEmitter {
  play = vi.fn();
  pause = vi.fn(() => true);
  unpause = vi.fn(() => true);
  stop = vi.fn(() => true);
  // helper to simulate a state transition
  transition(oldStatus: string, newStatus: string) {
    this.emit("stateChange", { status: oldStatus }, { status: newStatus });
  }
}
class FakeConnection extends EventEmitter {
  destroy = vi.fn();
  state = { status: "ready" };
}

function makeSession(idleMs = 1000) {
  const player = new FakePlayer();
  const conn = new FakeConnection();
  const session = new VoiceSession(conn as never, player as never, {
    channelId: "C1",
    idleTimeoutMs: idleMs,
  });
  return { session, player, conn };
}

describe("VoiceSession", () => {
  beforeEach(() => vi.useRealTimers());

  it("emits trackEnd when the player goes Playing -> Idle", () => {
    const { session, player } = makeSession();
    const onEnd = vi.fn();
    session.on("trackEnd", onEnd);
    player.transition("buffering", "playing"); // not an end
    player.transition("playing", "idle"); // end
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("does not emit trackEnd on an Idle->Idle (startup) transition", () => {
    const { session, player } = makeSession();
    const onEnd = vi.fn();
    session.on("trackEnd", onEnd);
    player.transition("idle", "idle");
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("forwards player errors", () => {
    const { session, player } = makeSession();
    const onErr = vi.fn();
    session.on("error", onErr);
    const err = new Error("decode failed");
    player.emit("error", err);
    expect(onErr).toHaveBeenCalledWith(err);
  });

  it("play/pause/resume/skip delegate to the player", () => {
    const { session, player } = makeSession();
    const res = {} as never;
    session.play(res);
    expect(player.play).toHaveBeenCalledWith(res);
    session.pause();
    expect(player.pause).toHaveBeenCalled();
    session.resume();
    expect(player.unpause).toHaveBeenCalled();
    session.skip();
    expect(player.stop).toHaveBeenCalled();
  });

  it("emits idle after the timeout, and cancel prevents it", async () => {
    vi.useFakeTimers();
    const { session } = makeSession(1000);
    const onIdle = vi.fn();
    session.on("idle", onIdle);
    session.startIdleTimer();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);

    const onIdle2 = vi.fn();
    session.on("idle", onIdle2);
    session.startIdleTimer();
    session.cancelIdleTimer();
    vi.advanceTimersByTime(2000);
    expect(onIdle2).not.toHaveBeenCalled();
  });

  it("destroy tears down the connection", () => {
    const { session, conn } = makeSession();
    session.destroy();
    expect(conn.destroy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run (RED), then implement `src/voice/session.ts`**

```ts
import { EventEmitter } from "node:events";

export interface VoicePlayerLike extends EventEmitter {
  play(resource: unknown): void;
  pause(): boolean;
  unpause(): boolean;
  stop(force?: boolean): boolean;
}
export interface VoiceConnectionLike extends EventEmitter {
  destroy(): void;
  readonly state: { status: string };
}
export interface VoiceSessionOptions {
  channelId: string;
  idleTimeoutMs: number;
}

const IDLE = "idle";

export class VoiceSession extends EventEmitter {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly connection: VoiceConnectionLike,
    private readonly player: VoicePlayerLike,
    private readonly opts: VoiceSessionOptions,
  ) {
    super();
    this.player.on("stateChange", (oldState: { status: string }, newState: { status: string }) => {
      if (newState.status === IDLE && oldState.status !== IDLE) {
        this.emit("trackEnd");
      }
    });
    this.player.on("error", (err: unknown) => this.emit("error", err));
  }

  get channelId(): string {
    return this.opts.channelId;
  }

  play(resource: unknown): void {
    this.cancelIdleTimer();
    this.player.play(resource);
  }
  pause(): void {
    this.player.pause();
  }
  resume(): void {
    this.player.unpause();
  }
  skip(): void {
    this.player.stop();
  }
  stop(): void {
    this.player.stop(true);
  }

  startIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.emit("idle");
    }, this.opts.idleTimeoutMs);
  }
  cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelIdleTimer();
    if (this.connection.state.status !== "destroyed") {
      this.connection.destroy();
    }
  }
}
```
Run: `npx vitest run src/voice/session.test.ts` → PASS.

- [ ] **Step 3: Write the real voice factory `src/voice/connect.ts` (glue — manual-verify, not unit-tested)**

```ts
import { createReadStream } from "node:fs";
import {
  joinVoiceChannel,
  entersState,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioResource,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { VoiceSession } from "./session.js";

/** Real connection: join + wait Ready (incl. DAVE handshake) + subscribe a player. */
export async function createVoiceSession(
  channel: VoiceBasedChannel,
  idleTimeoutMs: number,
): Promise<VoiceSession> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    connection.destroy();
    throw err;
  }
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  return new VoiceSession(connection as never, player as never, { channelId: channel.id, idleTimeoutMs });
}

/** Opus passthrough resource (probe the container; ffmpeg only if non-Opus). */
export async function createPassthroughResource(
  filePath: string,
  metadata: unknown,
): Promise<AudioResource> {
  const { stream, type } = await demuxProbe(createReadStream(filePath));
  return createAudioResource(stream, { inputType: type, inlineVolume: false, metadata });
}
```
> `connect.ts` is the only file that touches the real gateway/voice. It is verified manually with a real bot token (see Task 8 README), not by unit tests.

- [ ] **Step 4: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint` → green (session tested; connect.ts compiles).
```bash
git add -A && git commit -m "feat(voice): add VoiceSession state machine + real connect/resource factory"
```

---

### Task 5: GuildController orchestrator

**Files:** Create `src/orchestrator/index.ts`, `src/orchestrator/index.test.ts`

**Interfaces:**
- Consumes: `GuildQueue`, `YouTubeService`, `AudioCache`, `Semaphore`, `VoiceSession` (+ injected factories so it's testable without real voice).
- Produces: `class GuildController` with injected deps:

```ts
interface ControllerDeps {
  youtube: Pick<YouTubeService, "download">;
  cache: Pick<AudioCache, "get" | "has" | "register" | "pin" | "unpin">;
  cacheDir: string;
  createSession: (channelId: string) => Promise<VoiceSession>; // real or fake
  makeResource: (filePath: string, item: QueueItem) => unknown; // real or fake
  prefetchDepth: number;
  downloads: Semaphore;
  queue?: GuildQueue; // injectable for tests; defaults to a fresh GuildQueue
}
class GuildController {
  constructor(guildId: string, deps: ControllerDeps);
  readonly queue: GuildQueue;
  ensureConnected(channelId: string): Promise<void>;
  enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem>;
  skip(): void; pause(): void; resume(): void;
  stop(): Promise<void>;            // stop + clear + leave
  remove(itemId: string): Promise<boolean>;
  snapshot(): ReturnType<GuildQueue["snapshot"]>;
}
```

Behavior:
- Wires `queue.on("changed")` → if a session exists, the player is idle, there is no `current`, and `upcoming` is non-empty → `playNext()`.
- Wires `queue.on("prefetch", videoId)` → if `videoId` and not cached, `downloads.run(() => youtube.download(videoId, cacheDir))` then `cache.register(videoId, path)` + `cache.pin(videoId)`.
- `ensureConnected`: if no session, `createSession(channelId)`, wire its `trackEnd`→`playNext()`, `idle`→`leave()`, `error`→skip-on-error (`playNext()`).
- `enqueue`: `queue.add(meta, requester)`; then `maybeStart()` (if session idle & no current).
- `playNext()`: `const item = await queue.advance()`; if none → `session.startIdleTimer()`; else ensure the file is downloaded+cached (`cache.get(videoId)` or await download), `cache.pin`, `session.play(makeResource(path, item))`.
- `skip()`: `session.skip()` (→ trackEnd → playNext). `stop()`: `queue.clear()` + `session.stop()` + `leave()`. `leave()`: `session.destroy()`, null the session, unpin everything.
- A per-controller `Mutex` guards `playNext`/`ensureConnected` so concurrent triggers don't double-advance.

- [ ] **Step 1: Write the failing tests** (real `GuildQueue` + fakes for the rest)

`src/orchestrator/index.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { GuildController } from "./index.js";
import { Semaphore } from "../util/semaphore.js";
import type { Requester, TrackMeta } from "../types/index.js";

const requester: Requester = { discordUserId: "1", displayName: "u", avatarUrl: "a", source: "discord" };
const meta = (id: string): TrackMeta => ({
  videoId: id, title: id, channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null,
});

class FakeSession extends EventEmitter {
  play = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  skip = vi.fn(() => this.emit("trackEnd")); // simulate stop -> trackEnd
  stop = vi.fn();
  startIdleTimer = vi.fn();
  cancelIdleTimer = vi.fn();
  destroy = vi.fn();
  channelId = "C1";
}

function makeController() {
  const session = new FakeSession();
  const cacheStore = new Map<string, string>();
  const deps = {
    youtube: { download: vi.fn(async (id: string) => `/cache/${id}.webm`) },
    cache: {
      get: (id: string) => cacheStore.get(id) ?? null,
      has: (id: string) => cacheStore.has(id),
      register: (id: string, p: string) => cacheStore.set(id, p),
      pin: vi.fn(),
      unpin: vi.fn(),
    },
    cacheDir: "/cache",
    createSession: vi.fn(async () => session as never),
    makeResource: (p: string) => ({ res: p }),
    prefetchDepth: 1,
    downloads: new Semaphore(2),
  };
  const ctrl = new GuildController("G1", deps as never);
  return { ctrl, session, deps };
}

describe("GuildController", () => {
  it("enqueue connects, downloads, and plays the first track", async () => {
    const { ctrl, session, deps } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    // allow the changed/prefetch microtasks + playNext to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.youtube.download).toHaveBeenCalledWith("aaaaaaaaaaa", "/cache");
    expect(session.play).toHaveBeenCalledTimes(1);
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
  });

  it("advances to the next track on trackEnd, and idles when empty", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");

    session.emit("trackEnd"); // first ends
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");

    session.emit("trackEnd"); // second ends -> empty
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current).toBeNull();
    expect(session.startIdleTimer).toHaveBeenCalled();
  });

  it("skip stops the player (which advances)", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    await ctrl.enqueue(meta("aaaaaaaaaaa"), requester);
    await ctrl.enqueue(meta("bbbbbbbbbbb"), requester);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.skip(); // FakeSession.skip emits trackEnd
    await new Promise((r) => setTimeout(r, 0));
    expect(ctrl.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb");
  });

  it("idle event leaves the channel", async () => {
    const { ctrl, session } = makeController();
    await ctrl.ensureConnected("C1");
    session.emit("idle");
    await new Promise((r) => setTimeout(r, 0));
    expect(session.destroy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run (RED), then implement `src/orchestrator/index.ts`**

```ts
import { GuildQueue } from "../queue/index.js";
import { Mutex } from "../util/mutex.js";
import type { Semaphore } from "../util/semaphore.js";
import type { VoiceSession } from "../voice/session.js";
import type { QueueItem, Requester, TrackMeta } from "../types/index.js";

export interface ControllerDeps {
  youtube: { download(videoId: string, outDir: string): Promise<string> };
  cache: {
    get(id: string): string | null;
    has(id: string): boolean;
    register(id: string, path: string): void;
    pin(id: string): void;
    unpin(id: string): void;
  };
  cacheDir: string;
  createSession: (channelId: string) => Promise<VoiceSession>;
  makeResource: (filePath: string, item: QueueItem) => unknown;
  prefetchDepth: number;
  downloads: Semaphore;
  queue?: GuildQueue;
}

export class GuildController {
  readonly queue: GuildQueue;
  private session: VoiceSession | null = null;
  private readonly lock = new Mutex();
  private readonly pinned = new Set<string>();

  constructor(
    readonly guildId: string,
    private readonly deps: ControllerDeps,
  ) {
    this.queue = deps.queue ?? new GuildQueue();
    this.queue.on("prefetch", (videoId: string | null) => {
      if (videoId) void this.prefetch(videoId);
    });
    this.queue.on("changed", () => {
      void this.maybeStart();
    });
  }

  snapshot() {
    return this.queue.snapshot();
  }

  async ensureConnected(channelId: string): Promise<void> {
    if (this.session) return;
    const session = await this.deps.createSession(channelId);
    session.on("trackEnd", () => void this.playNext());
    session.on("error", () => void this.playNext()); // skip the broken track
    session.on("idle", () => void this.leave());
    this.session = session;
  }

  async enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
    const item = await this.queue.add(meta, requester);
    await this.maybeStart();
    return item;
  }

  skip(): void {
    this.session?.skip();
  }
  pause(): void {
    this.session?.pause();
  }
  resume(): void {
    this.session?.resume();
  }
  async remove(itemId: string): Promise<boolean> {
    return this.queue.remove(itemId);
  }
  async stop(): Promise<void> {
    await this.queue.clear();
    this.session?.stop();
    await this.leave();
  }

  private async maybeStart(): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (!this.session) return;
      if (this.queue.current) return; // already playing
      if (this.queue.snapshot().upcoming.length === 0) return;
      await this.playNextLocked();
    });
  }

  private async playNext(): Promise<void> {
    return this.lock.runExclusive(() => this.playNextLocked());
  }

  private async playNextLocked(): Promise<void> {
    if (!this.session) return;
    const item = await this.queue.advance();
    if (!item) {
      this.session.startIdleTimer();
      return;
    }
    const path = await this.ensureDownloaded(item.meta.videoId);
    this.deps.cache.pin(item.meta.videoId);
    this.pinned.add(item.meta.videoId);
    this.session.play(this.deps.makeResource(path, item));
  }

  private async ensureDownloaded(videoId: string): Promise<string> {
    const cached = this.deps.cache.get(videoId);
    if (cached) return cached;
    const path = await this.deps.downloads.run(() =>
      this.deps.youtube.download(videoId, this.deps.cacheDir),
    );
    this.deps.cache.register(videoId, path);
    return path;
  }

  private async prefetch(videoId: string): Promise<void> {
    if (this.deps.cache.has(videoId)) return;
    try {
      const path = await this.deps.downloads.run(() =>
        this.deps.youtube.download(videoId, this.deps.cacheDir),
      );
      this.deps.cache.register(videoId, path);
      this.deps.cache.pin(videoId);
      this.pinned.add(videoId);
    } catch {
      // prefetch is best-effort; a real failure surfaces when the track is played
    }
  }

  private async leave(): Promise<void> {
    this.session?.destroy();
    this.session = null;
    for (const id of this.pinned) this.deps.cache.unpin(id);
    this.pinned.clear();
  }
}
```
Run: `npx vitest run src/orchestrator/index.test.ts` → PASS.

> Note on the `changed`→`maybeStart` + `enqueue`→`maybeStart` double trigger: both funnel through the `Mutex` and each checks `queue.current`/`upcoming` before acting, so at most one `playNextLocked` runs for the first track — no double-advance. This is the same single-pop invariant the queue enforces.

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint` → green.
```bash
git add -A && git commit -m "feat(orchestrator): add GuildController wiring queue<->voice<->download"
```

---

### Task 6: GuildHub registry + search picker

**Files:** Create `src/orchestrator/hub.ts`, `src/orchestrator/hub.test.ts`, `src/discord/picker.ts`, `src/discord/picker.test.ts`

**Interfaces:**
- Produces:
  - `class GuildHub { get(guildId): GuildController }` — lazily creates one controller per guild from a shared dep factory.
  - `buildPicker(results: TrackMeta[]): { content: string; components: ActionRowBuilder<ButtonBuilder>[] }` and `decodePick(customId: string): string | null`.

- [ ] **Step 1: GuildHub test**

`src/orchestrator/hub.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { GuildHub } from "./hub.js";

describe("GuildHub", () => {
  it("creates one controller per guild and reuses it", () => {
    const factory = vi.fn((guildId: string) => ({ guildId }) as never);
    const hub = new GuildHub(factory);
    const a1 = hub.get("G1");
    const a2 = hub.get("G1");
    const b = hub.get("G2");
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Implement `src/orchestrator/hub.ts`**

```ts
import type { GuildController } from "./index.js";

export class GuildHub {
  private readonly controllers = new Map<string, GuildController>();
  constructor(private readonly factory: (guildId: string) => GuildController) {}

  get(guildId: string): GuildController {
    let c = this.controllers.get(guildId);
    if (!c) {
      c = this.factory(guildId);
      this.controllers.set(guildId, c);
    }
    return c;
  }
}
```
Run: `npx vitest run src/orchestrator/hub.test.ts` → PASS.

- [ ] **Step 3: Picker test**

`src/discord/picker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildPicker, decodePick } from "./picker.js";
import type { TrackMeta } from "../types/index.js";

const r = (id: string, title: string): TrackMeta => ({
  videoId: id, title, channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null,
});

describe("picker", () => {
  it("builds one button per result (max 5) with pick:<videoId> ids", () => {
    const results = [r("aaaaaaaaaaa", "A"), r("bbbbbbbbbbb", "B")];
    const { content, components } = buildPicker(results);
    expect(content).toContain("A");
    expect(content).toContain("B");
    const row = components[0]!;
    const json = row.toJSON();
    expect(json.components).toHaveLength(2);
    expect(json.components[0]!.custom_id).toBe("pick:aaaaaaaaaaa");
  });

  it("caps at 5 buttons", () => {
    const results = Array.from({ length: 8 }, (_, i) => r(`id${i}`.padEnd(11, "0"), `T${i}`));
    const { components } = buildPicker(results);
    const total = components.reduce((n, row) => n + row.toJSON().components.length, 0);
    expect(total).toBe(5);
  });

  it("decodePick extracts the videoId, or null for foreign ids", () => {
    expect(decodePick("pick:aaaaaaaaaaa")).toBe("aaaaaaaaaaa");
    expect(decodePick("other:x")).toBeNull();
  });
});
```

- [ ] **Step 4: Implement `src/discord/picker.ts`**

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { TrackMeta } from "../types/index.js";

const MAX = 5;

function fmtDuration(sec: number | null): string {
  if (sec === null) return "?:??";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function buildPicker(results: TrackMeta[]): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const top = results.slice(0, MAX);
  const content = top
    .map((t, i) => `**${i + 1}.** ${t.title} — ${t.channel} (${fmtDuration(t.durationSec)})`)
    .join("\n");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    top.map((t, i) =>
      new ButtonBuilder()
        .setCustomId(`pick:${t.videoId}`)
        .setLabel(String(i + 1))
        .setStyle(ButtonStyle.Primary),
    ),
  );
  return { content: content || "No results.", components: top.length ? [row] : [] };
}

export function decodePick(customId: string): string | null {
  return customId.startsWith("pick:") ? customId.slice("pick:".length) : null;
}
```
Run: `npx vitest run src/discord/picker.test.ts` → PASS.

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint` → green.
```bash
git add -A && git commit -m "feat: add GuildHub registry and button search picker"
```

---

### Task 7: Command handlers

**Files:** Create `src/discord/handlers.ts`, `src/discord/handlers.test.ts`

**Interfaces:**
- Consumes: `Command` (Task 2), `parseInput`, `YouTubeService`, `selectVoiceChannel` (Task 3), `GuildController`, `buildPicker`.
- Produces:
```ts
interface HandlerContext {
  controller: GuildController;
  youtube: Pick<YouTubeService, "resolve" | "search">;
  requester: Requester;
  requesterChannelId: string | null;
  botChannelId: string | null;
  isAdmin: boolean;
  searchLimit: number;
}
type HandlerResult =
  | { type: "message"; content: string }
  | { type: "picker"; content: string; components: ActionRowBuilder<ButtonBuilder>[] };
async function handleCommand(cmd: Command, ctx: HandlerContext): Promise<HandlerResult>;
```

Behavior per command:
- `play`: `parseInput(input)` → `reject` → message(reason). `video` → `resolve(videoId)` (catch `YtError` → message of a friendly reason), then `selectVoiceChannel` → if `!ok` message(reason) else `ensureConnected(channelId)` + `enqueue` → message("Queued **title**"). `query` → `search(query, limit)` → empty → message("No results.") else `buildPicker` → picker result.
- `skip`/`pause`/`resume`/`stop`/`remove`: call the controller, return a confirming message. (`remove` index is 1-based → map to the `upcoming[index-1]` itemId via `snapshot()`; out of range → message.)
- `queue`: format `snapshot()` (current + upcoming with requesters). `np`: format `current`. `help`: list commands. `none`: never reached (the bot filters before calling). 

- [ ] **Step 1: Write the failing tests** (fakes for controller + youtube)

`src/discord/handlers.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { handleCommand } from "./handlers.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import type { Requester, TrackMeta } from "../types/index.js";

const requester: Requester = { discordUserId: "1", displayName: "u", avatarUrl: "a", source: "discord" };
const meta = (id: string, title = id): TrackMeta => ({
  videoId: id, title, channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null,
});

function ctx(overrides: Partial<Parameters<typeof handleCommand>[1]> = {}) {
  const controller = {
    ensureConnected: vi.fn(async () => {}),
    enqueue: vi.fn(async () => ({ id: "i1" })),
    skip: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
  };
  return {
    controller: controller as never,
    youtube: { resolve: vi.fn(), search: vi.fn() },
    requester,
    requesterChannelId: "A",
    botChannelId: null,
    isAdmin: false,
    searchLimit: 5,
    ...overrides,
  };
}

describe("handleCommand — play", () => {
  it("queues an exact URL", async () => {
    const c = ctx();
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa", "Song"));
    const res = await handleCommand({ kind: "play", input: "https://youtu.be/aaaaaaaaaaa" }, c as never);
    expect(c.youtube.resolve).toHaveBeenCalledWith("aaaaaaaaaaa");
    expect(c.controller.ensureConnected).toHaveBeenCalledWith("A");
    expect(c.controller.enqueue).toHaveBeenCalled();
    expect(res).toEqual({ type: "message", content: expect.stringContaining("Song") });
  });

  it("rejects a non-YouTube URL without resolving", async () => {
    const c = ctx();
    const res = await handleCommand({ kind: "play", input: "https://vimeo.com/1" }, c as never);
    expect(c.youtube.resolve).not.toHaveBeenCalled();
    expect(res.type).toBe("message");
  });

  it("surfaces a friendly message on a YtError", async () => {
    const c = ctx();
    c.youtube.resolve.mockRejectedValue(new YtError(YtErrorKind.Private, "private"));
    const res = await handleCommand({ kind: "play", input: "https://youtu.be/aaaaaaaaaaa" }, c as never);
    expect(res).toEqual({ type: "message", content: expect.stringMatching(/private/i) });
    expect(c.controller.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to queue when the requester is not in a voice channel", async () => {
    const c = ctx({ requesterChannelId: null });
    c.youtube.resolve.mockResolvedValue(meta("aaaaaaaaaaa"));
    const res = await handleCommand({ kind: "play", input: "https://youtu.be/aaaaaaaaaaa" }, c as never);
    expect(c.controller.enqueue).not.toHaveBeenCalled();
    expect(res.type).toBe("message");
  });

  it("returns a picker for a search query", async () => {
    const c = ctx();
    c.youtube.search.mockResolvedValue([meta("aaaaaaaaaaa", "A"), meta("bbbbbbbbbbb", "B")]);
    const res = await handleCommand({ kind: "play", input: "daft punk" }, c as never);
    expect(c.youtube.search).toHaveBeenCalledWith("daft punk", 5);
    expect(res.type).toBe("picker");
  });
});

describe("handleCommand — controls", () => {
  it("skip/pause/resume/stop call the controller", async () => {
    const c = ctx();
    expect((await handleCommand({ kind: "skip" }, c as never)).type).toBe("message");
    expect(c.controller.skip).toHaveBeenCalled();
    await handleCommand({ kind: "pause" }, c as never);
    expect(c.controller.pause).toHaveBeenCalled();
    await handleCommand({ kind: "stop" }, c as never);
    expect(c.controller.stop).toHaveBeenCalled();
  });

  it("remove maps a 1-based index to the upcoming item id", async () => {
    const c = ctx();
    c.controller.snapshot.mockReturnValue({
      current: null,
      upcoming: [{ id: "i1" }, { id: "i2" }],
      history: [],
    } as never);
    await handleCommand({ kind: "remove", index: 2 }, c as never);
    expect(c.controller.remove).toHaveBeenCalledWith("i2");
  });

  it("help lists commands", async () => {
    const res = await handleCommand({ kind: "help" }, ctx() as never);
    expect(res).toEqual({ type: "message", content: expect.stringContaining("?play") });
  });
});
```

- [ ] **Step 2: Run (RED), then implement `src/discord/handlers.ts`**

```ts
import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import type { Command } from "./command-parser.js";
import { parseInput } from "../youtube/url-parser.js";
import { buildPicker } from "./picker.js";
import { selectVoiceChannel } from "../orchestrator/voice-selection.js";
import { YtError } from "../youtube/errors.js";
import type { GuildController } from "../orchestrator/index.js";
import type { Requester, TrackMeta } from "../types/index.js";

export interface HandlerContext {
  controller: Pick<
    GuildController,
    "ensureConnected" | "enqueue" | "skip" | "pause" | "resume" | "stop" | "remove" | "snapshot"
  >;
  youtube: {
    resolve(videoId: string): Promise<TrackMeta>;
    search(query: string, limit: number): Promise<TrackMeta[]>;
  };
  requester: Requester;
  requesterChannelId: string | null;
  botChannelId: string | null;
  isAdmin: boolean;
  searchLimit: number;
}

export type HandlerResult =
  | { type: "message"; content: string }
  | { type: "picker"; content: string; components: ActionRowBuilder<ButtonBuilder>[] };

const HELP = [
  "**Commands**",
  "`?play <youtube-url | search terms>` — queue a link, or search and pick",
  "`?skip` `?pause` `?resume` `?stop` — playback control",
  "`?queue` `?np` — show the queue / now playing",
  "`?remove <n>` — remove queue item n",
].join("\n");

function msg(content: string): HandlerResult {
  return { type: "message", content };
}

export async function handleCommand(cmd: Command, ctx: HandlerContext): Promise<HandlerResult> {
  switch (cmd.kind) {
    case "play":
      return handlePlay(cmd.input, ctx);
    case "skip":
      ctx.controller.skip();
      return msg("⏭️ Skipped.");
    case "pause":
      ctx.controller.pause();
      return msg("⏸️ Paused.");
    case "resume":
      ctx.controller.resume();
      return msg("▶️ Resumed.");
    case "stop":
      await ctx.controller.stop();
      return msg("⏹️ Stopped and cleared the queue.");
    case "remove":
      return handleRemove(cmd.index, ctx);
    case "queue":
      return msg(formatQueue(ctx));
    case "np":
      return msg(formatNowPlaying(ctx));
    case "help":
    case "none":
      return msg(HELP);
  }
}

async function handlePlay(input: string, ctx: HandlerContext): Promise<HandlerResult> {
  const parsed = parseInput(input);
  if (parsed.kind === "reject") return msg(`❌ ${parsed.reason}`);

  if (parsed.kind === "query") {
    const results = await ctx.youtube.search(parsed.query, ctx.searchLimit);
    if (results.length === 0) return msg("No results.");
    const picker = buildPicker(results);
    return { type: "picker", content: picker.content, components: picker.components };
  }

  // exact video
  let meta: TrackMeta;
  try {
    meta = await ctx.youtube.resolve(parsed.videoId);
  } catch (err) {
    return msg(err instanceof YtError ? `❌ Can't play that (${err.kind}).` : "❌ Failed to load that video.");
  }
  const target = selectVoiceChannel({
    requesterChannelId: ctx.requesterChannelId,
    botChannelId: ctx.botChannelId,
    isAdmin: ctx.isAdmin,
  });
  if (!target.ok) return msg(`❌ ${target.reason}`);
  await ctx.controller.ensureConnected(target.channelId);
  await ctx.controller.enqueue(meta, ctx.requester);
  return msg(`➕ Queued **${meta.title}**.`);
}

async function handleRemove(index: number, ctx: HandlerContext): Promise<HandlerResult> {
  const upcoming = ctx.controller.snapshot().upcoming;
  const item = upcoming[index - 1];
  if (!item) return msg(`No queue item #${index}.`);
  await ctx.controller.remove(item.id);
  return msg(`🗑️ Removed **${item.meta.title}**.`);
}

function formatNowPlaying(ctx: HandlerContext): string {
  const cur = ctx.controller.snapshot().current;
  if (!cur) return "Nothing is playing.";
  return `▶️ **${cur.meta.title}** — requested by ${cur.requester.displayName}`;
}

function formatQueue(ctx: HandlerContext): string {
  const { current, upcoming } = ctx.controller.snapshot();
  const lines: string[] = [];
  lines.push(current ? `▶️ **${current.meta.title}** (${current.requester.displayName})` : "Nothing playing.");
  if (upcoming.length) {
    lines.push("**Up next:**");
    upcoming.slice(0, 10).forEach((it, i) => lines.push(`${i + 1}. ${it.meta.title} (${it.requester.displayName})`));
    if (upcoming.length > 10) lines.push(`…and ${upcoming.length - 10} more`);
  }
  return lines.join("\n");
}
```
Run: `npx vitest run src/discord/handlers.test.ts` → PASS.

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint` → green.
```bash
git add -A && git commit -m "feat(discord): add command handlers"
```

---

### Task 8: Bot wiring, entrypoint, and Discord setup guide

**Files:** Create `src/discord/bot.ts`, `src/discord/bot.test.ts`, `src/index.ts` (replace the stub), `README.md`

**Interfaces:**
- Produces: `createBot(deps): Client` — builds the `Client` with the four intents and registers `messageCreate` (parse → resolve requester/bot voice state + admin → `handleCommand` → reply, sending picker components and wiring the button collector) and `interactionCreate` (button → `decodePick` → resolve + enqueue, attributed to the clicker). `src/index.ts` loads config, constructs the services, and logs in.

This task's logic that is unit-testable: the **intent list** and the **message→reply** glue via a fake message. The real gateway/login is manual-verify.

- [ ] **Step 1: Bot structural test**

`src/discord/bot.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { GatewayIntentBits } from "discord.js";
import { REQUIRED_INTENTS } from "./bot.js";

describe("bot intents", () => {
  it("requests exactly the four required intents", () => {
    expect(REQUIRED_INTENTS).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]);
  });
});
```

- [ ] **Step 2: Implement `src/discord/bot.ts`**

```ts
import {
  Client,
  GatewayIntentBits,
  Events,
  type Message,
  type Interaction,
} from "discord.js";
import { parseCommand } from "./command-parser.js";
import { handleCommand } from "./handlers.js";
import { decodePick } from "./picker.js";
import { selectVoiceChannel } from "../orchestrator/voice-selection.js";
import type { GuildHub } from "../orchestrator/hub.js";
import type { YouTubeService } from "../youtube/index.js";
import type { Requester } from "../types/index.js";

export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] as const;

export interface BotDeps {
  hub: GuildHub;
  youtube: YouTubeService;
  prefix: string;
  searchLimit: number;
  adminUserIds: ReadonlySet<string>;
}

function requesterOf(message: Message, source: "discord" | "web" = "discord"): Requester {
  const user = message.author;
  return {
    discordUserId: user.id,
    displayName: message.member?.displayName ?? user.username,
    avatarUrl: user.displayAvatarURL(),
    source,
  };
}

export function createBot(deps: BotDeps): Client {
  const client = new Client({ intents: [...REQUIRED_INTENTS] });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild()) return;
    const cmd = parseCommand(message.content, deps.prefix);
    if (cmd.kind === "none") return;

    const controller = deps.hub.get(message.guildId);
    const result = await handleCommand(cmd, {
      controller,
      youtube: deps.youtube,
      requester: requesterOf(message),
      requesterChannelId: message.member?.voice.channelId ?? null,
      botChannelId: message.guild.members.me?.voice.channelId ?? null,
      isAdmin: deps.adminUserIds.has(message.author.id),
      searchLimit: deps.searchLimit,
    });

    if (result.type === "picker") {
      await message.reply({ content: result.content, components: result.components });
    } else {
      await message.reply(result.content);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    const videoId = decodePick(interaction.customId);
    if (!videoId || !interaction.inGuild()) return;

    const member = interaction.member;
    const requesterChannelId =
      typeof member?.voice?.channelId === "string" ? member.voice.channelId : null;
    const botChannelId = interaction.guild?.members.me?.voice.channelId ?? null;
    const target = selectVoiceChannel({
      requesterChannelId,
      botChannelId,
      isAdmin: deps.adminUserIds.has(interaction.user.id),
    });
    if (!target.ok) {
      await interaction.reply({ content: `❌ ${target.reason}`, ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    try {
      const meta = await deps.youtube.resolve(videoId);
      const controller = deps.hub.get(interaction.guildId);
      await controller.ensureConnected(target.channelId);
      await controller.enqueue(meta, {
        discordUserId: interaction.user.id,
        displayName: interaction.user.username,
        avatarUrl: interaction.user.displayAvatarURL(),
        source: "discord",
      });
      await interaction.editReply({ content: `➕ Queued **${meta.title}**.`, components: [] });
    } catch {
      await interaction.editReply({ content: "❌ Failed to queue that result.", components: [] });
    }
  });

  return client;
}
```

- [ ] **Step 3: Replace `src/index.ts` with the real entrypoint**

```ts
import { loadMediaConfig } from "./config.js";
import { loadBotConfig } from "./config.js";
import { YouTubeService } from "./youtube/index.js";
import { AudioCache } from "./cache/index.js";
import { Semaphore } from "./util/semaphore.js";
import { GuildController } from "./orchestrator/index.js";
import { GuildHub } from "./orchestrator/hub.js";
import { createBot } from "./discord/bot.js";
import { createVoiceSession, createPassthroughResource } from "./voice/connect.js";
import type { Client } from "discord.js";

async function main(): Promise<void> {
  const media = loadMediaConfig();
  const bot = loadBotConfig();

  const youtube = new YouTubeService(media);
  const cache = new AudioCache(media.cacheDir, media.cacheMaxBytes);
  await cache.init();
  const downloads = new Semaphore(bot.maxConcurrentDownloads);

  // The hub creates one controller per guild; the controller's voice factory needs the
  // guild's channel object, which the bot resolves at connect time. We bridge via a
  // per-guild "connect" closure captured from discord.js when ensureConnected is called.
  const client: Client = createBot({
    hub: new GuildHub(
      (guildId) =>
        new GuildController(guildId, {
          youtube,
          cache,
          cacheDir: media.cacheDir,
          createSession: async (channelId) => {
            const guild = await client.guilds.fetch(guildId);
            const channel = await guild.channels.fetch(channelId);
            if (!channel?.isVoiceBased()) throw new Error("target channel is not a voice channel");
            return createVoiceSession(channel, bot.idleTimeoutMs);
          },
          makeResource: () => {
            throw new Error("makeResource is async-resolved in playNext"); // see note
          },
          prefetchDepth: bot.prefetchDepth,
          downloads,
        }),
    ),
    youtube,
    prefix: bot.commandPrefix,
    searchLimit: media.searchResultCount,
    adminUserIds: new Set(bot.adminUserIds),
  });

  await client.login(bot.discordToken);
  // eslint-disable-next-line no-console
  console.log("discord-yt-music-bot is online");
}

void main();
```

> **Implementation note for the agent:** the `makeResource` dep in `GuildController` (Task 5) is synchronous, but `createPassthroughResource` is async (it `demuxProbe`s). Resolve this when wiring Task 8: change `GuildController.playNextLocked` to `await` an async `makeResource` (update the `ControllerDeps.makeResource` type to `(filePath, item) => unknown | Promise<unknown>` and `await` it). Update the Task 5 fake accordingly (it already returns a plain object, which `await` accepts). Make this small adjustment as part of Task 8 and re-run the Task 5 tests to confirm they still pass. Then `createSession`/`makeResource` use `createVoiceSession`/`createPassthroughResource` from `connect.ts`.

- [ ] **Step 4: Run the structural test (RED→GREEN) + full suite + typecheck**

Run: `npx vitest run src/discord/bot.test.ts` → PASS.
Run: `npm test && npm run typecheck && npm run lint` → all green. (The `index.ts`/`bot.ts`/`connect.ts` gateway code compiles but is not unit-executed.)

- [ ] **Step 5: Write `README.md` with the Discord application setup guide**

Create `README.md` covering: creating a Discord application + bot, enabling the **Message Content** privileged intent, the OAuth2 invite URL with `bot` scope + permissions (View Channel, Send Messages, Connect, Speak, Use Voice Activity), the `.env` variables (`DISCORD_TOKEN`, `CACHE_DIR`, `IDLE_TIMEOUT_SEC`, `ADMIN_USER_IDS`, …), and how to run (`npm run dev` for local, Docker later in Plan 3/deploy). Include a **Manual verification checklist** for the gateway/voice paths that unit tests can't cover: bot comes online; `?play <url>` joins voice and plays; `?skip`/`?pause`/`?resume`/`?stop` work; `?<search terms>` shows the button picker and a click queues the exact pick; idle auto-leave after the timeout.

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "feat(discord): wire Client/intents, entrypoint, and README setup guide"
```

---

## Self-Review

**1. Spec coverage (Plan 2 scope = playback):**
- §4 `voice/` (per-guild session, join/leave, player, events, idle auto-leave) → Task 4 ✔; §5.3 DAVE+AEAD handled automatically by the pinned `@discordjs/voice` + `@noble/ciphers` (Task 1 deps) ✔; §5.2 Opus passthrough via `demuxProbe` + `inlineVolume:false` → Task 4 `connect.ts` ✔.
- §4 `orchestrator/` (queue↔voice wiring, prefetch download w/ concurrency cap, single-pop invariant) → Tasks 5–6 ✔.
- §4 `discord/` (`?` commands, button picker, intents incl. MessageContent) → Tasks 2,6,7,8 ✔.
- §6 command set (`?play/skip/pause/resume/stop/queue/np/remove/help`, bare `?<url|query>`) → Tasks 2,7 ✔; §6.1 voice-channel selection (author's channel; admin move; reject when none) → Task 3 ✔.
- §8 requester attribution carried into `enqueue` (message author / button clicker) → Tasks 7,8 ✔.
- §11 friendly typed-error messages on resolve failure → Task 7 ✔; idle auto-leave → Tasks 4,5 ✔.
- **Deferred (correctly out of Plan 2 scope):** REST/WS/OAuth (Plan 3), frontend (Plan 4), Dockerfile/compose/CI + graceful-shutdown + active-session snapshot (Plan 3/deploy). Loudness-normalization + SponsorBlock are config in the Plan 1 YouTubeService already.

**2. Placeholder scan:** none — every step has runnable code/commands. The one cross-task adjustment (sync→async `makeResource`) is called out explicitly in Task 8's note with the exact change and the re-test instruction.

**3. Type consistency:** `Command` (Task 2) consumed by Task 7/8; `selectVoiceChannel` (Task 3) by Tasks 7/8; `VoiceSession` (Task 4) by Task 5; `GuildController` (Task 5) by Tasks 6/7/8; `GuildHub` (Task 6) by Task 8; `buildPicker`/`decodePick` (Task 6) by Tasks 7/8; `BotConfig`/`Semaphore` (Task 1) by Tasks 5/8. Plan 1 consumed signatures (`parseInput`, `YouTubeService`, `AudioCache`, `GuildQueue`, `Requester`/`TrackMeta`/`QueueItem`) match their merged definitions. The single-pop invariant (only `advance()` pops `current`) is preserved: the controller never calls `advance()` on a user skip — it calls `session.skip()` → `player.stop()` → `trackEnd` → `playNext()` → `advance()`.

**4. Sandbox reality:** deps verified to install/load on Node 20; all gateway/voice/audio behavior is isolated to `connect.ts`, `bot.ts`, `index.ts` and is **manual-verify** with a real token (README checklist). Everything else is unit-tested.
