# discord-yt-music-bot — Plan 3: Web API + OAuth2 + WebSocket

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expose the bot's per-guild state and controls over a secure web API: Discord OAuth2 login (with `state` CSRF), server-side sessions, **bot-verified** authorization, REST endpoints that drive the same `GuildHub` controllers the Discord bot uses, a live WebSocket feed, and rate limiting — all served from the same Node process as the bot, behind a reverse proxy.

**Architecture:** A Fastify v5 app assembled in `server/app.ts`, registered into the existing `index.ts` process next to the discord.js `Client` (they share the `GuildHub`, `YouTubeService`, and `Client`). `auth/` holds OAuth2 (state, code exchange, identity), a server-side session store, and the `canControl` predicate (authoritative against the bot's own guild membership, never the user's OAuth guild list). `server/rest.ts` is the REST surface (tested with Fastify `app.inject()` + fakes), `server/ws.ts` is a per-guild broadcaster fed by `GuildController` `"changed"` events with an Origin-checked, cookie-authenticated upgrade.

**Tech Stack:** Plan 1/2 stack + `fastify@^5`, `@fastify/cookie@^11`, `@fastify/session@^11`, `@fastify/rate-limit@^10`, `@fastify/static@^9`, `@fastify/websocket@^11`.

**Companion reference:** [verified API reference](../research/2026-06-25-verified-api-reference.md) §3 (Fastify/OAuth/WS). **Spec:** [design spec](../specs/2026-06-25-discord-yt-music-bot-design.md) §7 (auth), §8 (attribution), §9 (REST+WS contract), §11 (lifecycle).

**Consumes from Plans 1–2:** `GuildHub.get(guildId)→GuildController`; `GuildController` (`ensureConnected`, `enqueue`, `skip`, `pause`, `resume`, `stop`, `remove`, `snapshot`, and its `queue` `EventEmitter` emitting `"changed"`); `YouTubeService` (`resolve`, `search`); `parseInput`; `Requester`/`TrackMeta`/`QueueItem`; `loadBotConfig`/`loadMediaConfig`. The discord.js `Client` (for `canControl` membership checks + resolving voice channels).

## Global Constraints

- Node 22.12+ target, ESM NodeNext (**`.js` relative imports**), strict TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), no DOM in tsconfig.
- **Plugin versions (verified):** fastify 5.8, @fastify/cookie 11, @fastify/session 11, @fastify/rate-limit 10, @fastify/static 9, @fastify/websocket 11. `@fastify/session` (server-side store) — NOT secure-session. Register `@fastify/cookie` before `@fastify/session`.
- **OAuth endpoints:** authorize `https://discord.com/oauth2/authorize` (**no `/api`**); token `https://discord.com/api/oauth2/token`; revoke `https://discord.com/api/oauth2/token/revoke`; identity `https://discord.com/api/v10/users/@me`. Scope `identify guilds`. `expires_in` is **seconds**; cookie `maxAge` is **ms**.
- **State CSRF (mandatory):** random `state` at `/auth/login` stored in the pre-auth session; verified with `crypto.timingSafeEqual` and **consumed** at `/auth/callback`; reject on mismatch. Verify the granted `scope` actually contains `identify`+`guilds`.
- **Session cookie:** `httpOnly:true`, `secure: NODE_ENV==='production'`, `sameSite:'lax'`, `path:'/'`, explicit `maxAge`; `saveUninitialized:false`; rotate the session id on login (`session.regenerate()`); logout destroys the server-side record.
- **Authorization (`canControl`):** authoritative source is the **bot's** guild membership — `client.guilds.cache.get(guildId)` then `await guild.members.fetch(userId)`; admin allowlist (`ADMIN_USER_IDS`, strict `/^\d{17,20}$/`). The OAuth `guilds` list is a **UI hint only**; `/api/me` returns only the bot-verified intersection.
- **WebSocket:** authenticate the upgrade via the session cookie; **validate `Origin` against an allowlist** (blocks cross-site WS hijack); authorize each guild subscription via `canControl`; re-validate periodically and close `1008` on loss. One socket, `{subscribe:guildId}`/`{unsubscribe}` topics.
- **Rate limit:** global keyed by `session.userId ?? req.ip`; stricter on `/play`, `/pick`, `/auth/login`.
- **Reverse proxy:** `Fastify({ trustProxy: true })` so secure cookies + `req.ip` + protocol work; build `redirect_uri` from `PUBLIC_BASE_URL` (must byte-match the Discord portal).
- **Item ids, not indices:** queue mutations use stable `itemId` (remove/reorder).
- **Testability:** REST handlers tested via `app.inject()` with a fake `GuildHub`/`YouTubeService`/`Client`. OAuth code-exchange tested with a mocked `fetch`. `canControl` + session store + state + broadcaster are pure-unit. The live OAuth round-trip and a real browser WS are **manual-verify** (README checklist extended).
- Commits: conventional; branch `plan-3-web`; squash-merge to master at the end.

---

## File Structure (Plan 3)

```
src/
├── config.ts                  # T1 — loadWebConfig()
├── types/config-types.ts      # T1 — WebConfig
├── auth/
│   ├── session-store.ts       # T2 — MemorySessionStore (+test)
│   ├── oauth.ts               # T3/T4 — state + authorize URL + code exchange + identity (+tests)
│   ├── authz.ts               # T5 — canControl, parseAdminIds (+test)
│   └── routes.ts              # T8 — /auth/login, /auth/callback, /auth/logout (plugin)
├── server/
│   ├── rest.ts                # T6 — REST routes plugin (+inject test)
│   ├── ws.ts                  # T7 — GuildBroadcaster + ws plugin (+test)
│   └── app.ts                 # T8 — buildApp() assembling the fastify instance (+inject test)
└── index.ts                   # T8 — wire buildApp + client into one process
```

---

### Task 1: Web config + Fastify deps

**Files:** Modify `package.json`, `src/config.ts`, `src/types/config-types.ts`. Create `src/config.web.test.ts`.

**Interfaces:** `WebConfig { clientId, clientSecret, publicBaseUrl, redirectUri, sessionSecret, port, host, trustProxy, allowedWsOrigins: string[], nodeEnv, secureCookies }`; `loadWebConfig(env?): WebConfig`.

- [ ] **Step 1: Install deps**

Run: `npm install fastify@^5 @fastify/cookie@^11 @fastify/session@^11 @fastify/rate-limit@^10 @fastify/static@^9 @fastify/websocket@^11`
Expected: installs (EBADENGINE warning on Node 20 is fine).

- [ ] **Step 2: Add `WebConfig` to `src/types/config-types.ts`**

```ts
export interface WebConfig {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  redirectUri: string;
  sessionSecret: string;
  port: number;
  host: string;
  trustProxy: boolean;
  allowedWsOrigins: string[];
  nodeEnv: string;
  secureCookies: boolean;
}
```

- [ ] **Step 3: Write the failing test `src/config.web.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadWebConfig } from "./config.js";

const base = {
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "secret",
  PUBLIC_BASE_URL: "https://music.example.com",
  SESSION_SECRET: "x".repeat(32),
};

describe("loadWebConfig", () => {
  it("derives redirectUri from PUBLIC_BASE_URL and applies defaults", () => {
    const c = loadWebConfig(base);
    expect(c.redirectUri).toBe("https://music.example.com/auth/callback");
    expect(c.port).toBe(8080);
    expect(c.allowedWsOrigins).toEqual(["https://music.example.com"]);
    expect(c.secureCookies).toBe(false); // NODE_ENV unset → not production
  });
  it("strips a trailing slash from PUBLIC_BASE_URL", () => {
    expect(loadWebConfig({ ...base, PUBLIC_BASE_URL: "https://m.example.com/" }).redirectUri)
      .toBe("https://m.example.com/auth/callback");
  });
  it("honors OAUTH_REDIRECT_URI override and production secure cookies", () => {
    const c = loadWebConfig({ ...base, OAUTH_REDIRECT_URI: "https://m/cb", NODE_ENV: "production" });
    expect(c.redirectUri).toBe("https://m/cb");
    expect(c.secureCookies).toBe(true);
  });
  it("throws when a required var is missing", () => {
    expect(() => loadWebConfig({})).toThrow();
    expect(() => loadWebConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
});
```

- [ ] **Step 4: Run (RED), implement `loadWebConfig` in `src/config.ts`**

```ts
export type { WebConfig } from "./types/config-types.js";
import type { WebConfig } from "./types/config-types.js";

export function loadWebConfig(env: Env = process.env): WebConfig {
  const clientId = strEnv(env, "DISCORD_CLIENT_ID");
  const clientSecret = strEnv(env, "DISCORD_CLIENT_SECRET");
  const publicBaseUrlRaw = strEnv(env, "PUBLIC_BASE_URL");
  const sessionSecret = strEnv(env, "SESSION_SECRET");
  if (!clientId) throw new Error("DISCORD_CLIENT_ID is required");
  if (!clientSecret) throw new Error("DISCORD_CLIENT_SECRET is required");
  if (!publicBaseUrlRaw) throw new Error("PUBLIC_BASE_URL is required");
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET is required and must be at least 32 characters");
  }
  const publicBaseUrl = publicBaseUrlRaw.replace(/\/$/, "");
  const nodeEnv = strEnv(env, "NODE_ENV") ?? "development";
  return {
    clientId,
    clientSecret,
    publicBaseUrl,
    redirectUri: strEnv(env, "OAUTH_REDIRECT_URI") ?? `${publicBaseUrl}/auth/callback`,
    sessionSecret,
    port: intEnv(env, "PORT", 8080),
    host: strEnv(env, "HOST") ?? "0.0.0.0",
    trustProxy: (strEnv(env, "TRUST_PROXY") ?? "true") !== "false",
    allowedWsOrigins: (strEnv(env, "ALLOWED_WS_ORIGINS") ?? publicBaseUrl)
      .split(",").map((s) => s.trim()).filter(Boolean),
    nodeEnv,
    secureCookies: nodeEnv === "production",
  };
}
```

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint` → green.
```bash
git add -A && git commit -m "feat(config): add fastify deps and loadWebConfig"
```

---

### Task 2: Server-side session store

**Files:** Create `src/auth/session-store.ts`, `src/auth/session-store.test.ts`

**Interfaces:** `class MemorySessionStore` implementing `@fastify/session`'s callback store: `set(sid, session, cb)`, `get(sid, cb)`, `destroy(sid, cb)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { MemorySessionStore } from "./session-store.js";

function p<T>(fn: (cb: (e: unknown, r?: T) => void) => void): Promise<T | undefined> {
  return new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r))));
}

describe("MemorySessionStore", () => {
  it("round-trips set → get and destroy removes", async () => {
    const s = new MemorySessionStore();
    await p((cb) => s.set("sid1", { userId: "u1" } as never, cb));
    const got = await p<{ userId: string }>((cb) => s.get("sid1", cb as never));
    expect(got).toEqual({ userId: "u1" });
    await p((cb) => s.destroy("sid1", cb));
    const after = await p((cb) => s.get("sid1", cb as never));
    expect(after ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run (RED), implement `src/auth/session-store.ts`**

```ts
type Cb<T = void> = (err: unknown, result?: T) => void;

export class MemorySessionStore {
  private readonly store = new Map<string, unknown>();

  set(sessionId: string, session: unknown, cb: Cb): void {
    this.store.set(sessionId, session);
    cb(null);
  }
  get(sessionId: string, cb: Cb<unknown>): void {
    cb(null, this.store.get(sessionId) ?? null);
  }
  destroy(sessionId: string, cb: Cb): void {
    this.store.delete(sessionId);
    cb(null);
  }
}
```
Run the test → PASS.

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "feat(auth): add in-memory server-side session store"
```

---

### Task 3: OAuth2 state + authorize URL

**Files:** Create `src/auth/oauth.ts`, `src/auth/oauth.state.test.ts`

**Interfaces:** `DISCORD` endpoint constants; `generateState(): string`; `verifyState(received, expected): boolean` (timing-safe, length-guarded); `buildAuthorizeUrl(cfg, state): string`; `avatarUrl(user, size?): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { generateState, verifyState, buildAuthorizeUrl, avatarUrl } from "./oauth.js";

describe("oauth state + urls", () => {
  it("generates distinct, urlsafe states", () => {
    const a = generateState(), b = generateState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("verifyState is true only for an exact match", () => {
    const s = generateState();
    expect(verifyState(s, s)).toBe(true);
    expect(verifyState(s, generateState())).toBe(false);
    expect(verifyState("", s)).toBe(false);
    expect(verifyState(s, undefined)).toBe(false);
  });
  it("buildAuthorizeUrl includes the required params", () => {
    const url = new URL(buildAuthorizeUrl(
      { clientId: "cid", redirectUri: "https://m/cb" } as never, "STATE"));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe("identify guilds");
    expect(url.searchParams.get("redirect_uri")).toBe("https://m/cb");
    expect(url.searchParams.get("state")).toBe("STATE");
  });
  it("avatarUrl builds a CDN url or a default", () => {
    expect(avatarUrl({ id: "1", avatar: "abc" })).toContain("/avatars/1/abc.png");
    expect(avatarUrl({ id: "1", avatar: "a_xyz" })).toContain(".gif");
    expect(avatarUrl({ id: "22", avatar: null })).toContain("/embed/avatars/");
  });
});
```

- [ ] **Step 2: Run (RED), implement the state/URL parts of `src/auth/oauth.ts`**

```ts
import crypto from "node:crypto";
import type { WebConfig } from "../config.js";

export const DISCORD = {
  AUTHORIZE_URL: "https://discord.com/oauth2/authorize",
  TOKEN_URL: "https://discord.com/api/oauth2/token",
  REVOKE_URL: "https://discord.com/api/oauth2/token/revoke",
  USER_URL: "https://discord.com/api/v10/users/@me",
  SCOPE: "identify guilds",
} as const;

export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function verifyState(received: string, expected: string | undefined): boolean {
  if (!received || !expected || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function buildAuthorizeUrl(cfg: Pick<WebConfig, "clientId" | "redirectUri">, state: string): string {
  const url = new URL(DISCORD.AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("scope", DISCORD.SCOPE);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "none");
  return url.toString();
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar: string | null;
}

export function avatarUrl(user: Pick<DiscordUser, "id" | "avatar">, size = 128): string {
  if (user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
  }
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
```
Run the test → PASS.

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "feat(auth): add OAuth2 state + authorize URL helpers"
```

---

### Task 4: OAuth2 code exchange + identity

**Files:** Modify `src/auth/oauth.ts`. Create `src/auth/oauth.exchange.test.ts`.

**Interfaces:** `exchangeCode(cfg, code): Promise<TokenResponse>` (throws on non-OK or missing scope); `fetchIdentity(accessToken): Promise<DiscordUser>`; `revokeToken(cfg, token): Promise<void>`. Uses global `fetch` (mocked in tests).

- [ ] **Step 1: Write the failing test (mock global fetch)**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeCode, fetchIdentity } from "./oauth.js";

const cfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://m/cb" } as never;

function mockFetch(spec: Array<{ ok: boolean; json: unknown }>) {
  const fn = vi.fn();
  spec.forEach((s) => fn.mockResolvedValueOnce({ ok: s.ok, json: async () => s.json }));
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("exchangeCode", () => {
  it("posts the code and returns the token when scope is sufficient", async () => {
    const fn = mockFetch([{ ok: true, json: { access_token: "AT", token_type: "Bearer", expires_in: 604800, refresh_token: "RT", scope: "identify guilds" } }]);
    const tok = await exchangeCode(cfg, "CODE");
    expect(tok.access_token).toBe("AT");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("https://discord.com/api/oauth2/token");
    expect((init as RequestInit).method).toBe("POST");
    expect(String((init as RequestInit).body)).toContain("grant_type=authorization_code");
    expect(String((init as RequestInit).body)).toContain("code=CODE");
  });
  it("throws when the token endpoint fails", async () => {
    mockFetch([{ ok: false, json: {} }]);
    await expect(exchangeCode(cfg, "CODE")).rejects.toThrow();
  });
  it("throws when the granted scope is missing identify or guilds", async () => {
    mockFetch([{ ok: true, json: { access_token: "AT", token_type: "Bearer", expires_in: 1, refresh_token: "RT", scope: "identify" } }]);
    await expect(exchangeCode(cfg, "CODE")).rejects.toThrow(/scope/i);
  });
});

describe("fetchIdentity", () => {
  it("returns the user on success and throws on failure", async () => {
    mockFetch([{ ok: true, json: { id: "1", username: "u", global_name: "U", avatar: null } }]);
    const me = await fetchIdentity("AT");
    expect(me.id).toBe("1");
    mockFetch([{ ok: false, json: {} }]);
    await expect(fetchIdentity("AT")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run (RED), append to `src/auth/oauth.ts`**

```ts
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function exchangeCode(
  cfg: Pick<WebConfig, "clientId" | "clientSecret" | "redirectUri">,
  code: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(DISCORD.TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const token = (await res.json()) as TokenResponse;
  const granted = new Set(token.scope.split(" "));
  if (!granted.has("identify") || !granted.has("guilds")) {
    throw new Error("insufficient OAuth scope (need identify and guilds)");
  }
  return token;
}

export async function fetchIdentity(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(DISCORD.USER_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`identity fetch failed (${res.status})`);
  return (await res.json()) as DiscordUser;
}

export async function revokeToken(
  cfg: Pick<WebConfig, "clientId" | "clientSecret">,
  token: string,
): Promise<void> {
  await fetch(DISCORD.REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, token }),
  }).catch(() => undefined);
}
```
Run the test → PASS.

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "feat(auth): add OAuth2 code exchange + identity fetch"
```

---

### Task 5: Bot-verified authorization (`canControl`)

**Files:** Create `src/auth/authz.ts`, `src/auth/authz.test.ts`

**Interfaces:** `parseAdminIds(env): Set<string>`; `canControl(client, userId, guildId, adminIds): Promise<boolean>` where `client` is the minimal shape `{ guilds: { cache: Map<string, { members: { fetch(id): Promise<unknown> } }> } }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { canControl, parseAdminIds } from "./authz.js";

const SNOW = "123456789012345678";
const GUILD = "234567890123456789";

function clientWith(opts: { hasGuild: boolean; isMember: boolean }) {
  const guild = {
    members: { fetch: vi.fn(async (id: string) => (opts.isMember ? { id } : Promise.reject(new Error("Unknown Member")))) },
  };
  return { guilds: { cache: new Map(opts.hasGuild ? [[GUILD, guild]] : []) } } as never;
}

describe("parseAdminIds", () => {
  it("keeps valid snowflakes, drops junk", () => {
    expect([...parseAdminIds({ ADMIN_USER_IDS: `${SNOW}, 99, ${GUILD}` })]).toEqual([SNOW, GUILD]);
  });
});

describe("canControl", () => {
  it("true when the bot verifies the user is a member of the guild", async () => {
    expect(await canControl(clientWith({ hasGuild: true, isMember: true }), SNOW, GUILD, new Set())).toBe(true);
  });
  it("false when the user is not a member", async () => {
    expect(await canControl(clientWith({ hasGuild: true, isMember: false }), SNOW, GUILD, new Set())).toBe(false);
  });
  it("false when the bot is not in the guild", async () => {
    expect(await canControl(clientWith({ hasGuild: false, isMember: true }), SNOW, GUILD, new Set())).toBe(false);
  });
  it("true for an admin even if not a member (admin allowlist)", async () => {
    expect(await canControl(clientWith({ hasGuild: false, isMember: false }), SNOW, GUILD, new Set([SNOW]))).toBe(true);
  });
  it("false for malformed ids", async () => {
    expect(await canControl(clientWith({ hasGuild: true, isMember: true }), "bad", GUILD, new Set())).toBe(false);
  });
});
```

- [ ] **Step 2: Run (RED), implement `src/auth/authz.ts`**

```ts
const SNOWFLAKE = /^\d{17,20}$/;

export function parseAdminIds(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => SNOWFLAKE.test(s)),
  );
}

interface MinimalGuild {
  members: { fetch(userId: string): Promise<unknown> };
}
interface MinimalClient {
  guilds: { cache: Map<string, MinimalGuild> };
}

export async function canControl(
  client: MinimalClient,
  userId: string,
  guildId: string,
  adminIds: ReadonlySet<string>,
): Promise<boolean> {
  if (!SNOWFLAKE.test(userId) || !SNOWFLAKE.test(guildId)) return false;
  if (adminIds.has(userId)) return true;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;
  try {
    const member = await guild.members.fetch(userId);
    return member != null;
  } catch {
    return false;
  }
}
```
Run the test → PASS.

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "feat(auth): add bot-verified canControl authorization"
```

---

### Task 6: REST routes

**Files:** Create `src/server/rest.ts`, `src/server/rest.test.ts`

**Interfaces:** a Fastify plugin `registerRest(app, deps)` where
```ts
interface RestDeps {
  hub: { get(guildId: string): Controller };
  youtube: { resolve(id: string): Promise<TrackMeta>; search(q: string, n: number): Promise<TrackMeta[]> };
  client: MinimalClient;       // for canControl
  adminIds: ReadonlySet<string>;
  searchLimit: number;
}
interface Controller {
  ensureConnected(channelId: string): Promise<void>;
  enqueue(meta: TrackMeta, requester: Requester): Promise<{ id: string }>;
  skip(): void; pause(): void; resume(): void; stop(): Promise<void>;
  remove(itemId: string): Promise<boolean>;
  reorder?(itemId: string, toIndex: number): Promise<boolean>;
  snapshot(): { current: unknown; upcoming: { id: string }[]; history: unknown };
}
```
Routes (all under a guard that requires `request.session.userId`; guild routes also require `canControl`):
`GET /api/me`, `GET /api/guilds/:id/state`, `POST /api/guilds/:id/play` `{input, voiceChannelId?}`, `POST /api/guilds/:id/pick` `{videoId, voiceChannelId?}`, `POST /api/guilds/:id/skip|pause|resume|stop`, `POST /api/guilds/:id/queue/remove` `{itemId}`, `POST /api/guilds/:id/queue/reorder` `{itemId, toIndex}`. A logged-out request → 401; a non-member (and non-admin) → 403.

This task tests the routes with `app.inject()`, injecting a tiny test harness that pre-populates `request.session` via a decorator (so we don't need the full session plugin in the unit test).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRest } from "./rest.js";

const USER = "123456789012345678";
const GUILD = "234567890123456789";
const meta = (id: string, title = id) => ({ videoId: id, title, channel: "c", durationSec: 1, isLive: false, thumbnailUrl: null });

function build(sessionUserId: string | null, depOverrides: Record<string, unknown> = {}) {
  const controller = {
    ensureConnected: vi.fn(async () => {}),
    enqueue: vi.fn(async () => ({ id: "i1" })),
    skip: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(async () => {}),
    remove: vi.fn(async () => true), reorder: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
  };
  const guild = { members: { fetch: vi.fn(async (id: string) => ({ id })) } };
  const deps = {
    hub: { get: vi.fn(() => controller) },
    youtube: { resolve: vi.fn(async (id: string) => meta(id, "Song")), search: vi.fn(async () => [meta("aaaaaaaaaaa", "A")]) },
    client: { guilds: { cache: new Map([[GUILD, guild]]) } },
    adminIds: new Set<string>(),
    searchLimit: 5,
    ...depOverrides,
  };
  const app = Fastify();
  // emulate the session: a preHandler that sets request.session from a header
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req) => {
    (req as { session: unknown }).session = sessionUserId ? { userId: sessionUserId } : {};
  });
  registerRest(app, deps as never);
  return { app, controller, deps };
}

describe("REST auth gating", () => {
  it("401 when not logged in", async () => {
    const { app } = build(null);
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/state` });
    expect(res.statusCode).toBe(401);
  });
  it("403 when logged in but not a guild member / admin", async () => {
    const guild = { members: { fetch: vi.fn(async () => { throw new Error("Unknown Member"); }) } };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({ method: "POST", url: `/api/guilds/${GUILD}/skip` });
    expect(res.statusCode).toBe(403);
  });
});

describe("REST actions", () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(USER); });

  it("GET /api/me returns the user", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(USER);
  });
  it("play with a URL resolves + enqueues (attributed to the web user)", async () => {
    const res = await h.app.inject({
      method: "POST", url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa", voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.ensureConnected).toHaveBeenCalledWith("C1");
    const [, requester] = h.controller.enqueue.mock.calls[0]!;
    expect(requester).toMatchObject({ discordUserId: USER, source: "web" });
  });
  it("play with a query returns candidates (no enqueue)", async () => {
    const res = await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/play`, payload: { input: "daft punk" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates).toHaveLength(1);
    expect(h.controller.enqueue).not.toHaveBeenCalled();
  });
  it("play with a non-YouTube URL is rejected (400), no resolve", async () => {
    const res = await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/play`, payload: { input: "https://vimeo.com/1" } });
    expect(res.statusCode).toBe(400);
    expect(h.deps.youtube.resolve).not.toHaveBeenCalled();
  });
  it("skip/pause/resume/stop call the controller", async () => {
    for (const action of ["skip", "pause", "resume", "stop"] as const) {
      const res = await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/${action}` });
      expect(res.statusCode).toBe(200);
    }
    expect(h.controller.skip).toHaveBeenCalled();
    expect(h.controller.stop).toHaveBeenCalled();
  });
  it("queue/remove and reorder use the itemId", async () => {
    await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/queue/remove`, payload: { itemId: "i9" } });
    expect(h.controller.remove).toHaveBeenCalledWith("i9");
    await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/queue/reorder`, payload: { itemId: "i9", toIndex: 0 } });
    expect(h.controller.reorder).toHaveBeenCalledWith("i9", 0);
  });
});
```

- [ ] **Step 2: Run (RED), implement `src/server/rest.ts`**

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { parseInput } from "../youtube/url-parser.js";
import { canControl } from "../auth/authz.js";
import { avatarUrl, type DiscordUser } from "../auth/oauth.js";
import { YtError } from "../youtube/errors.js";
import type { Requester, TrackMeta } from "../types/index.js";

interface Controller {
  ensureConnected(channelId: string): Promise<void>;
  enqueue(meta: TrackMeta, requester: Requester): Promise<{ id: string }>;
  skip(): void; pause(): void; resume(): void; stop(): Promise<void>;
  remove(itemId: string): Promise<boolean>;
  reorder(itemId: string, toIndex: number): Promise<boolean>;
  snapshot(): { current: unknown; upcoming: { id: string }[]; history: unknown };
}
export interface RestDeps {
  hub: { get(guildId: string): Controller };
  youtube: { resolve(id: string): Promise<TrackMeta>; search(q: string, n: number): Promise<TrackMeta[]> };
  client: Parameters<typeof canControl>[0];
  adminIds: ReadonlySet<string>;
  searchLimit: number;
}

function sessionUser(req: FastifyRequest): (DiscordUser & { id: string }) | null {
  const s = (req as { session?: { userId?: string; user?: DiscordUser } }).session;
  if (!s?.userId) return null;
  return (s.user ?? { id: s.userId, username: s.userId, avatar: null }) as DiscordUser;
}

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  // auth guard for all /api routes except /api/me handles its own
  async function requireLogin(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const user = sessionUser(req);
    if (!user) { await reply.code(401).send({ error: "unauthenticated" }); return null; }
    return user.id;
  }
  async function requireControl(req: FastifyRequest, reply: FastifyReply, guildId: string): Promise<boolean> {
    const userId = await requireLogin(req, reply);
    if (!userId) return false;
    if (!(await canControl(deps.client, userId, guildId, deps.adminIds))) {
      await reply.code(403).send({ error: "forbidden" });
      return false;
    }
    return true;
  }

  app.get("/api/me", async (req, reply) => {
    const user = sessionUser(req);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return { user: { id: user.id, username: user.global_name ?? user.username, avatarUrl: avatarUrl(user) } };
  });

  app.get<{ Params: { id: string } }>("/api/guilds/:id/state", async (req, reply) => {
    if (!(await requireControl(req, reply, req.params.id))) return;
    return deps.hub.get(req.params.id).snapshot();
  });

  app.post<{ Params: { id: string }; Body: { input?: string; voiceChannelId?: string } }>(
    "/api/guilds/:id/play",
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const input = (req.body?.input ?? "").toString();
      const parsed = parseInput(input);
      if (parsed.kind === "reject") return reply.code(400).send({ error: parsed.reason });
      if (parsed.kind === "query") {
        return { candidates: await deps.youtube.search(parsed.query, deps.searchLimit) };
      }
      return enqueueVideo(req, reply, parsed.videoId);
    },
  );

  app.post<{ Params: { id: string }; Body: { videoId?: string; voiceChannelId?: string } }>(
    "/api/guilds/:id/pick",
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const videoId = (req.body?.videoId ?? "").toString();
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return reply.code(400).send({ error: "bad videoId" });
      return enqueueVideo(req, reply, videoId);
    },
  );

  async function enqueueVideo(req: FastifyRequest, reply: FastifyReply, videoId: string) {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { voiceChannelId?: string };
    const user = sessionUser(req)!;
    let meta: TrackMeta;
    try {
      meta = await deps.youtube.resolve(videoId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof YtError ? err.kind : "resolve_failed" });
    }
    const controller = deps.hub.get(params.id);
    if (body.voiceChannelId) await controller.ensureConnected(body.voiceChannelId);
    const requester: Requester = {
      discordUserId: user.id,
      displayName: user.global_name ?? user.username,
      avatarUrl: avatarUrl(user),
      source: "web",
    };
    const item = await controller.enqueue(meta, requester);
    return { queued: { id: item.id, title: meta.title } };
  }

  for (const action of ["skip", "pause", "resume", "stop"] as const) {
    app.post<{ Params: { id: string } }>(`/api/guilds/:id/${action}`, async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const c = deps.hub.get(req.params.id);
      await Promise.resolve(c[action]());
      return { ok: true };
    });
  }

  app.post<{ Params: { id: string }; Body: { itemId?: string } }>(
    "/api/guilds/:id/queue/remove",
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const ok = await deps.hub.get(req.params.id).remove((req.body?.itemId ?? "").toString());
      return { ok };
    },
  );

  app.post<{ Params: { id: string }; Body: { itemId?: string; toIndex?: number } }>(
    "/api/guilds/:id/queue/reorder",
    async (req, reply) => {
      if (!(await requireControl(req, reply, req.params.id))) return;
      const ok = await deps.hub.get(req.params.id).reorder(
        (req.body?.itemId ?? "").toString(), Number(req.body?.toIndex ?? 0));
      return { ok };
    },
  );
}
```

- [ ] **Step 3: Run (GREEN) + full suite + typecheck + commit**

Run: `npx vitest run src/server/rest.test.ts` → PASS, then `npm test && npm run typecheck && npm run lint`.
```bash
git add -A && git commit -m "feat(server): add REST API routes with auth + canControl gating"
```

---

### Task 7: WebSocket broadcaster + upgrade auth

**Files:** Create `src/server/ws.ts`, `src/server/ws.test.ts`

**Interfaces:**
- `class GuildBroadcaster` — `subscribe(guildId, send)`, `unsubscribe(guildId, send)`, `broadcast(guildId, payload)`, `attach(guildId, controller)` (wires the controller's `queue.on("changed")` → `broadcast(guildId, {type:"state", state})`, once per guild).
- `isAllowedOrigin(origin, allowed): boolean`.
- `registerWebsocket(app, deps)` — `@fastify/websocket` route `/ws` with an `onRequest` Origin check and per-message `{subscribe}`/`{unsubscribe}` handlers gated by `canControl`, with periodic re-validation. (The route wiring is glue; the broadcaster + origin check are unit-tested.)

- [ ] **Step 1: Write the failing test (broadcaster + origin)**

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { GuildBroadcaster, isAllowedOrigin } from "./ws.js";

describe("isAllowedOrigin", () => {
  it("matches the allowlist exactly", () => {
    const allow = ["https://m.example.com"];
    expect(isAllowedOrigin("https://m.example.com", allow)).toBe(true);
    expect(isAllowedOrigin("https://evil.com", allow)).toBe(false);
    expect(isAllowedOrigin(undefined, allow)).toBe(false);
  });
});

describe("GuildBroadcaster", () => {
  it("broadcasts only to subscribers of a guild", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn(), c = vi.fn();
    b.subscribe("G1", a);
    b.subscribe("G2", c);
    b.broadcast("G1", { type: "state", state: 1 });
    expect(a).toHaveBeenCalledWith({ type: "state", state: 1 });
    expect(c).not.toHaveBeenCalled();
  });
  it("stops sending after unsubscribe", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn();
    b.subscribe("G1", a);
    b.unsubscribe("G1", a);
    b.broadcast("G1", { type: "state", state: 1 });
    expect(a).not.toHaveBeenCalled();
  });
  it("attach wires controller.queue 'changed' to a state broadcast (once per guild)", () => {
    const b = new GuildBroadcaster();
    const queue = new EventEmitter();
    const controller = { queue, snapshot: () => ({ current: null, upcoming: [], history: [] }) };
    const sub = vi.fn();
    b.attach("G1", controller as never);
    b.attach("G1", controller as never); // second attach must NOT double-wire
    b.subscribe("G1", sub);
    queue.emit("changed");
    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }));
  });
});
```

- [ ] **Step 2: Run (RED), implement `src/server/ws.ts`**

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { canControl } from "../auth/authz.js";

type Send = (payload: unknown) => void;

interface ControllerLike {
  queue: { on(event: "changed", listener: () => void): unknown };
  snapshot(): unknown;
}

export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return !!origin && allowed.includes(origin);
}

export class GuildBroadcaster {
  private readonly subs = new Map<string, Set<Send>>();
  private readonly wired = new Set<string>();

  subscribe(guildId: string, send: Send): void {
    let set = this.subs.get(guildId);
    if (!set) this.subs.set(guildId, (set = new Set()));
    set.add(send);
  }
  unsubscribe(guildId: string, send: Send): void {
    this.subs.get(guildId)?.delete(send);
  }
  broadcast(guildId: string, payload: unknown): void {
    for (const send of this.subs.get(guildId) ?? []) send(payload);
  }
  attach(guildId: string, controller: ControllerLike): void {
    if (this.wired.has(guildId)) return;
    this.wired.add(guildId);
    controller.queue.on("changed", () => this.broadcast(guildId, { type: "state", state: controller.snapshot() }));
  }
}

export interface WsDeps {
  broadcaster: GuildBroadcaster;
  hub: { get(guildId: string): ControllerLike };
  client: Parameters<typeof canControl>[0];
  adminIds: ReadonlySet<string>;
  allowedOrigins: readonly string[];
  revalidateMs?: number;
}

// Glue: registers the /ws route (manual-verify with a real browser).
export function registerWebsocket(app: FastifyInstance, deps: WsDeps): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") {
      if (!isAllowedOrigin(req.headers.origin, deps.allowedOrigins)) {
        await reply.code(403).send({ error: "bad_origin" });
      }
    }
  });

  app.get("/ws", { websocket: true }, (socket: WsSocket, req: FastifyRequest) => {
    const userId = (req as { session?: { userId?: string } }).session?.userId;
    if (!userId) { socket.close(1008, "unauthenticated"); return; }
    const send: Send = (p) => socket.send(JSON.stringify(p));
    const subscribed = new Set<string>();

    socket.on("message", async (raw: Buffer) => {
      let msg: { subscribe?: string; unsubscribe?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.subscribe) {
        const gid = msg.subscribe;
        if (!(await canControl(deps.client, userId, gid, deps.adminIds))) {
          send({ type: "error", guildId: gid, reason: "forbidden" }); return;
        }
        deps.broadcaster.attach(gid, deps.hub.get(gid));
        deps.broadcaster.subscribe(gid, send);
        subscribed.add(gid);
        send({ type: "state", guildId: gid, state: deps.hub.get(gid).snapshot() });
      }
      if (msg.unsubscribe) {
        deps.broadcaster.unsubscribe(msg.unsubscribe, send);
        subscribed.delete(msg.unsubscribe);
      }
    });

    const iv = setInterval(async () => {
      for (const gid of subscribed) {
        if (!(await canControl(deps.client, userId, gid, deps.adminIds))) {
          deps.broadcaster.unsubscribe(gid, send);
          subscribed.delete(gid);
          send({ type: "revoked", guildId: gid });
        }
      }
    }, deps.revalidateMs ?? 30_000);

    socket.on("close", () => {
      clearInterval(iv);
      for (const gid of subscribed) deps.broadcaster.unsubscribe(gid, send);
    });
  });
}

// Minimal shape of the ws socket we use (avoids importing 'ws' types here).
interface WsSocket {
  send(data: string): void;
  close(code: number, reason?: string): void;
  on(event: "message" | "close", listener: (data: Buffer) => void): void;
}
```

- [ ] **Step 3: Run (GREEN) + commit**

Run: `npx vitest run src/server/ws.test.ts` then `npm test && npm run typecheck && npm run lint`.
```bash
git add -A && git commit -m "feat(server): add WebSocket guild broadcaster + origin/cookie upgrade auth"
```

---

### Task 8: App assembly + auth routes + entrypoint wiring

**Files:** Create `src/auth/routes.ts`, `src/server/app.ts`, `src/server/app.test.ts`. Modify `src/index.ts`. Extend `README.md`.

**Interfaces:** `registerAuthRoutes(app, deps)` (`/auth/login`, `/auth/callback`, `/auth/logout`); `buildApp(deps): Promise<FastifyInstance>` (assembles cookie→session→rate-limit→static→websocket→rest→auth, `/healthz`, `trustProxy`).

- [ ] **Step 1: Write `src/auth/routes.ts`** (uses Tasks 3–4 helpers)

```ts
import type { FastifyInstance } from "fastify";
import { buildAuthorizeUrl, exchangeCode, fetchIdentity, generateState, revokeToken, verifyState } from "./oauth.js";
import type { WebConfig } from "../config.js";

declare module "fastify" {
  interface Session {
    oauthState?: string;
    userId?: string;
    user?: { id: string; username: string; global_name?: string | null; avatar: string | null };
  }
}

export function registerAuthRoutes(app: FastifyInstance, cfg: WebConfig): void {
  app.get("/auth/login", async (req, reply) => {
    const state = generateState();
    req.session.oauthState = state;
    return reply.redirect(buildAuthorizeUrl(cfg, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/callback",
    async (req, reply) => {
      const { code, state, error } = req.query;
      const expected = req.session.oauthState;
      req.session.oauthState = undefined;
      if (error) return reply.code(400).send({ error });
      if (!code || !state || !verifyState(state, expected)) {
        return reply.code(400).send({ error: "invalid_state" });
      }
      let user;
      try {
        const token = await exchangeCode(cfg, code);
        user = await fetchIdentity(token.access_token);
        await revokeToken(cfg, token.access_token); // we don't keep Discord tokens
      } catch {
        return reply.code(502).send({ error: "oauth_failed" });
      }
      await req.session.regenerate();
      req.session.userId = user.id;
      req.session.user = user;
      return reply.redirect("/");
    },
  );

  app.post("/auth/logout", async (req, reply) => {
    await req.session.destroy();
    return reply.clearCookie("sid", { path: "/" }).code(204).send();
  });
}
```

- [ ] **Step 2: Write `src/server/app.ts`**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { MemorySessionStore } from "../auth/session-store.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { registerRest, type RestDeps } from "./rest.js";
import { registerWebsocket, GuildBroadcaster } from "./ws.js";
import type { WebConfig } from "../config.js";

export interface AppDeps extends RestDeps {
  cfg: WebConfig;
  broadcaster?: GuildBroadcaster;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.cfg.trustProxy, logger: false });

  await app.register(cookie);
  await app.register(session, {
    secret: deps.cfg.sessionSecret,
    cookieName: "sid",
    store: new MemorySessionStore() as never,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/",
      httpOnly: true,
      secure: deps.cfg.secureCookies,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req as { session?: { userId?: string } }).session?.userId ?? req.ip,
  });
  await app.register(websocket);

  app.get("/healthz", async () => ({ ok: true }));
  registerAuthRoutes(app, deps.cfg);
  registerRest(app, deps);
  registerWebsocket(app, {
    broadcaster: deps.broadcaster ?? new GuildBroadcaster(),
    hub: deps.hub as never,
    client: deps.client,
    adminIds: deps.adminIds,
    allowedOrigins: deps.cfg.allowedWsOrigins,
  });
  return app;
}
```

- [ ] **Step 3: Write `src/server/app.test.ts`** (inject — healthz + login redirect + unauth gate)

```ts
import { describe, it, expect, vi } from "vitest";
import { buildApp } from "./app.js";

const cfg = {
  clientId: "cid", clientSecret: "sec", publicBaseUrl: "https://m", redirectUri: "https://m/auth/callback",
  sessionSecret: "x".repeat(32), port: 8080, host: "0.0.0.0", trustProxy: true,
  allowedWsOrigins: ["https://m"], nodeEnv: "test", secureCookies: false,
};
function deps() {
  return {
    cfg,
    hub: { get: vi.fn(() => ({ snapshot: () => ({}), queue: { on: vi.fn() } })) },
    youtube: { resolve: vi.fn(), search: vi.fn() },
    client: { guilds: { cache: new Map() } },
    adminIds: new Set<string>(),
    searchLimit: 5,
  } as never;
}

describe("buildApp", () => {
  it("serves /healthz", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
  it("/auth/login redirects to Discord with a state cookie set", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("discord.com/oauth2/authorize");
    expect(res.headers["set-cookie"]).toBeTruthy();
    await app.close();
  });
  it("guards /api/me when logged out", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 4: Run (RED→GREEN)**

Run: `npx vitest run src/server/app.test.ts` → PASS (resolve any plugin-registration ordering issues per the verified reference: cookie before session). Then `npm test && npm run typecheck && npm run lint`.

- [ ] **Step 5: Wire the server into `src/index.ts`**

In `main()` (after building `youtube`, `cache`, `hub`, `client`, and logging in), add:
```ts
  const web = loadWebConfig();
  const broadcaster = new GuildBroadcaster();
  const app = await buildApp({
    cfg: web,
    hub,
    youtube,
    client: client as never,
    adminIds: new Set(bot.adminUserIds),
    searchLimit: media.searchResultCount,
    broadcaster,
  });
  await app.listen({ port: web.port, host: web.host });
  console.log(`web panel listening on ${web.host}:${web.port}`);
```
Import `loadWebConfig` from `./config.js`, `buildApp`/`GuildBroadcaster` from `./server/app.js` and `./server/ws.js`. (The `@fastify/static` serving of the built frontend is added in Plan 4 once `web/dist` exists; until then the API + `/healthz` run standalone.)

- [ ] **Step 6: Extend `README.md`**

Add a **Web panel** section: the additional `.env` vars (`DISCORD_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `OAUTH_REDIRECT_URI`, `SESSION_SECRET`, `PORT`, `TRUST_PROXY`, `ALLOWED_WS_ORIGINS`), the **OAuth2 redirect URI** that must be registered in the Discord Developer Portal (`<PUBLIC_BASE_URL>/auth/callback`, exact match), the reverse-proxy note, and a **manual-verify checklist** for the OAuth round-trip + live WebSocket (login redirects to Discord and back; `/api/me` returns you; `/api/guilds/:id/state` works for a server you're in and 403s for one you're not; the WS pushes state on play/skip).

- [ ] **Step 7: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build` → all green.
```bash
git add -A && git commit -m "feat(server): assemble fastify app, auth routes, and wire into the process"
```

---

## Self-Review

**1. Spec coverage (Plan 3 scope = web API + auth):**
- §7.1 OAuth2 + `state` CSRF + scope verification → Tasks 3,4,8 ✔. §7.2 server-side sessions + cookie attrs + rotation + logout-revoke → Tasks 2,8 ✔. §7.3 bot-verified `canControl` + admin allowlist + `/api/me` intersection → Tasks 5,6 ✔. §7.4 rate limiting → Task 8 ✔.
- §8 attribution (web requests → `source:"web"`, logged-in user) → Task 6 ✔.
- §9 REST contract (me/state/play/pick/skip/pause/resume/stop/queue.remove/queue.reorder, itemId-based, 401/403) → Task 6 ✔; `/healthz` → Task 8 ✔; WS upgrade auth + Origin + topic subscribe + re-validate + live state → Task 7 ✔.
- §11 reverse-proxy/trustProxy → Tasks 1,8 ✔.
- **Deferred (out of scope):** the React panel + `@fastify/static` serving (Plan 4); Dockerfile/compose/CI + graceful shutdown + active-session snapshot (deploy plan). The WS route glue + live OAuth round-trip are manual-verify (README).

**2. Placeholder scan:** none — every step has runnable code/commands. Plugin-ordering caveat (cookie before session) is called out in Task 8 Step 4.

**3. Type consistency:** `WebConfig`/`loadWebConfig` (T1) used by T3/4/8; `MemorySessionStore` (T2) by T8; `generateState`/`verifyState`/`buildAuthorizeUrl`/`exchangeCode`/`fetchIdentity`/`avatarUrl`/`DiscordUser` (T3/4) by T6/8; `canControl`/`parseAdminIds` (T5) by T6/7/8; `RestDeps`/`registerRest` (T6) by T8; `GuildBroadcaster`/`isAllowedOrigin`/`registerWebsocket` (T7) by T8. The `Controller`/`Requester`/`TrackMeta` shapes match Plan 2's `GuildController` (`ensureConnected`/`enqueue`/`skip`/`pause`/`resume`/`stop`/`remove`/`reorder`/`snapshot`, `queue` emitting `"changed"`) and Plan 1 types. `canControl`'s minimal client shape is satisfied by the real discord.js `Client` (`guilds.cache.get(id).members.fetch(userId)`).

**4. Sandbox reality:** REST tested via `app.inject()`; OAuth via mocked `fetch`; canControl/session/state/broadcaster pure-unit. The live OAuth round-trip and browser WebSocket are manual-verify with a real Discord app + reverse proxy.
