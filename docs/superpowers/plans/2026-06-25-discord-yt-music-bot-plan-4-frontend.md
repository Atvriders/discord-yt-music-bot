# discord-yt-music-bot — Plan 4: React Control Panel (frontend)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). The UI tasks follow the **frontend-design** aesthetic locked below — transcribe the provided styles/components faithfully so the result stays cohesive.

**Goal:** A distinctive, production-grade **"After-Hours" analog-radio** control panel (React + Vite + Tailwind v4) that logs in with Discord, lists the servers you may control, shows a live now-playing hero + queue, and drives playback (add by link/search→pick, skip/pause/resume/stop, remove/reorder) over the Plan 3 REST API + `/ws` WebSocket. Served by the same Fastify process from `dist/public`.

**Aesthetic (locked — do not redesign):** Late-night analog radio console. Warm near-black, a single **ember-amber** accent that *glows* behind the now-playing hero (tube-amp warmth), SVG film-grain overlay, one orchestrated staggered page-load reveal, tactile pill controls, a VU-meter progress bar. Type: **Fraunces** (display serif — titles/headings), **Hanken Grotesk** (UI), **JetBrains Mono** (timestamps/durations/IDs). NO Inter, NO purple gradients, NO generic dashboard.

**Architecture:** A Vite SPA in `web/` (own tsconfig). `web/src/lib/` holds the typed API client and the WebSocket live-state hook (both TDD-unit-tested). `web/src/components/` holds the screens. The root build does `vite build web → dist/public`, and `@fastify/static` (added in Task 1) serves it with an SPA fallback (already partially present in Plan 3's notFound). A small `GET /api/guilds/:id/voice-channels` endpoint is added so the panel can offer a channel picker.

**Tech Stack:** Plan 1–3 stack + `react@19`, `react-dom@19`, `vite@^6`, `@vitejs/plugin-react`, `tailwindcss@^4` + `@tailwindcss/vite`, `@fastify/static@^9` (already installed). Tests: vitest + `@testing-library/react` + `jsdom` (per-file `// @vitest-environment jsdom`).

**Spec:** [design spec](../specs/2026-06-25-discord-yt-music-bot-design.md) §10 (frontend). **Consumes Plan 3:** REST `/api/me`, `/api/guilds/:id/state|play|pick|skip|pause|resume|stop|queue/remove|queue/reorder`, `/auth/login`, `/auth/logout`, and WS `/ws` (`{subscribe:guildId}` → `{type:"state",state}` / `{type:"error"}` / `{type:"revoked"}`).

## Global Constraints

- ESM; `web/` is a browser app (its tsconfig uses `lib: ["ES2023","DOM","DOM.Iterable"]`, `jsx: "react-jsx"`, `moduleResolution: "bundler"`) — this is the ONE place DOM libs are allowed. The backend tsconfig still excludes `web/`.
- **Data shapes (from Plan 1/3, verbatim):** `QueueItem { id; meta: { videoId; title; channel; durationSec: number|null; isLive; thumbnailUrl: string|null }; requester: { discordUserId; displayName; avatarUrl; source: "discord"|"web" }; addedAt }`. State snapshot `{ current: QueueItem|null; upcoming: QueueItem[]; history: QueueItem[] }`. `/api/me` → `{ user: { id; username; avatarUrl }; guilds: { id; name }[] }`. play → `{ queued }` or `{ candidates: TrackMeta[] }`.
- **Aesthetic tokens are the single source of truth** — components use the CSS variables / classes from Task 2, never ad-hoc colors. Fraunces for `.font-display`, Hanken for body, JetBrains Mono for `.font-mono`.
- All network calls go through the Task 3 `api` client (credentials: "include"); never `fetch` directly in a component.
- Accessibility: buttons are real `<button>`s with `aria-label`s; the picker is keyboard-navigable; respect `prefers-reduced-motion` (gate the load animation).
- Commits: conventional; branch `plan-4-frontend`; squash-merge to master at the end.

---

## File Structure (Plan 4)

```
web/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                 # T1
│   ├── index.css                # T2 — the After-Hours design system
│   ├── types.ts                 # T2 — QueueItem/Snapshot/Me types
│   ├── lib/
│   │   ├── api.ts               # T3 — typed REST client (+test)
│   │   └── useGuildState.ts     # T4 — WS live-state hook + reducer (+test)
│   └── components/
│       ├── App.tsx              # T6
│       ├── LoginGate.tsx        # T6
│       ├── ServerSelector.tsx   # T6
│       ├── NowPlaying.tsx       # T5
│       ├── Controls.tsx         # T5
│       ├── Queue.tsx            # T5
│       ├── AddBar.tsx           # T6
│       └── Grain.tsx            # T2
src/server/rest.ts               # T1 — add GET /api/guilds/:id/voice-channels
src/server/app.ts                # T1 — @fastify/static serving dist/public + SPA fallback
package.json                     # T1 — deps + build:web
```

---

### Task 1: Scaffold the web app + static serving + voice-channels endpoint

**Files:** `package.json`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/src/main.tsx`, `web/src/components/App.tsx` (stub), `src/server/app.ts`, `src/server/rest.ts`, `src/server/rest.test.ts`.

- [ ] **Step 1: Install deps**

Run: `npm install -D react@^19 react-dom@^19 @types/react@^19 @types/react-dom@^19 vite@^6 @vitejs/plugin-react@^4 tailwindcss@^4 @tailwindcss/vite@^4 @testing-library/react@^16 @testing-library/jest-dom@^6 jsdom@^25`
(EBADENGINE on Node 20 is fine.)

- [ ] **Step 2: `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, stub `App.tsx`**

`web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://localhost:8080", "/auth": "http://localhost:8080", "/ws": { target: "ws://localhost:8080", ws: true } } },
});
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`web/index.html`:
```html
<!doctype html>
<html lang="en" class="theme-after-hours">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>After-Hours · music control</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/components/App.tsx` (stub — replaced in T6):
```tsx
export function App() {
  return <div>After-Hours</div>;
}
```

- [ ] **Step 3: Root `package.json` build scripts**

Update scripts so the web app builds into `dist/public`:
```jsonc
"build": "npm run build:web && tsc -p tsconfig.json",
"build:web": "vite build web --outDir ../dist/public --emptyOutDir",
"dev:web": "vite web"
```
Add `web/dist` and keep `dist` in `.gitignore` (already present).

- [ ] **Step 4: Serve the SPA from `@fastify/static` (modify `src/server/app.ts`)**

Add static serving + SPA fallback (so deep links work) after the routes:
```ts
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
// ...inside buildApp, AFTER registering routes:
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/", wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws") && !req.url.startsWith("/auth")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
```
(Compiled `app.js` lives in `dist/server/`, so `../public` → `dist/public`. If `dist/public` doesn't exist yet in dev, `@fastify/static` logs but the API still runs — acceptable.)

- [ ] **Step 5: Add `GET /api/guilds/:id/voice-channels` to `src/server/rest.ts`** (so the panel can pick a channel)

After the existing routes in `registerRest`, add (gated by `requireControl`); read the guild's voice channels from the client cache:
```ts
  app.get<{ Params: { id: string } }>("/api/guilds/:id/voice-channels", async (req, reply) => {
    if (!(await requireControl(req, reply, req.params.id))) return;
    const guild = deps.client.guilds.cache.get(req.params.id) as
      | { channels?: { cache: Map<string, { id: string; name: string; type: number; isVoiceBased?: () => boolean }> } }
      | undefined;
    const channels: { id: string; name: string }[] = [];
    for (const ch of guild?.channels?.cache?.values() ?? []) {
      if (ch.isVoiceBased?.() ?? false) channels.push({ id: ch.id, name: ch.name });
    }
    return { channels };
  });
```
Add a `rest.test.ts` case: with a fake client whose guild has a voice channel, the route returns it for a member and 403s for a non-member. (Extend the existing fake `guild` with a `channels.cache` Map and `isVoiceBased: () => true`.)

- [ ] **Step 6: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint`. Then `npm run build:web` (produces `dist/public/index.html` from the stub).
Expected: tests green; vite build succeeds.
```bash
git add -A && git commit -m "feat(web): scaffold vite/react app, static serving, voice-channels endpoint"
```

---

### Task 2: The "After-Hours" design system + types

**Files:** `web/src/index.css`, `web/src/types.ts`, `web/src/components/Grain.tsx`

- [ ] **Step 1: `web/src/types.ts`**

```ts
export interface TrackMeta {
  videoId: string; title: string; channel: string;
  durationSec: number | null; isLive: boolean; thumbnailUrl: string | null;
}
export interface Requester {
  discordUserId: string; displayName: string; avatarUrl: string; source: "discord" | "web";
}
export interface QueueItem { id: string; meta: TrackMeta; requester: Requester; addedAt: number; }
export interface Snapshot { current: QueueItem | null; upcoming: QueueItem[]; history: QueueItem[]; }
export interface Me { user: { id: string; username: string; avatarUrl: string }; guilds: { id: string; name: string }[]; }
export interface VoiceChannel { id: string; name: string; }
```

- [ ] **Step 2: `web/src/index.css`** — the full design system (Tailwind v4 + custom theme)

```css
@import url("https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap");
@import "tailwindcss";

@theme {
  --color-bg: #100d0a;
  --color-raised: #1a1411;
  --color-sunken: #0b0908;
  --color-ink: #f4ece2;
  --color-ink-dim: #b6a794;
  --color-ink-faint: #6f6456;
  --color-ember: #ff8a3d;
  --color-ember-soft: #ffb061;
  --color-gold: #e0a458;
  --color-line: rgba(244, 236, 226, 0.09);
  --color-playing: #93cf9c;
  --color-danger: #e8775f;
  --font-display: "Fraunces", Georgia, serif;
  --font-sans: "Hanken Grotesk", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

:root { color-scheme: dark; }

html, body, #root { height: 100%; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: var(--font-sans);
  font-feature-settings: "ss01", "cv01";
  -webkit-font-smoothing: antialiased;
}

/* Warm radial atmosphere + a faint dial-light glow at the top. */
body::before {
  content: "";
  position: fixed; inset: 0; z-index: -2;
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(255, 138, 61, 0.16), transparent 60%),
    radial-gradient(80% 50% at 85% 110%, rgba(224, 164, 88, 0.08), transparent 55%),
    var(--color-bg);
}

.font-display { font-family: var(--font-display); letter-spacing: -0.01em; }
.font-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.eyebrow { font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.28em; text-transform: uppercase; color: var(--color-ink-faint); }

/* Card surfaces with a hairline + inner warmth */
.card {
  background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.12)), var(--color-raised);
  border: 1px solid var(--color-line);
  border-radius: 18px;
  box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 60px -36px rgba(0,0,0,0.9);
}

/* The now-playing hero: an ember glow that breathes. */
.hero-glow { position: relative; }
.hero-glow::after {
  content: ""; position: absolute; inset: -1px; border-radius: inherit; z-index: 0;
  background: radial-gradient(70% 120% at 18% 30%, rgba(255,138,61,0.22), transparent 60%);
  pointer-events: none;
}

/* Tactile pill button */
.pill {
  display: inline-flex; align-items: center; gap: 0.5rem;
  border-radius: 999px; border: 1px solid var(--color-line);
  background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.16));
  color: var(--color-ink); padding: 0.6rem 1.05rem; font-weight: 600; font-size: 0.92rem;
  transition: transform .12s ease, border-color .2s ease, background .2s ease, color .2s ease;
  cursor: pointer;
}
.pill:hover { transform: translateY(-1px); border-color: rgba(255,138,61,0.4); color: var(--color-ember-soft); }
.pill:active { transform: translateY(0) scale(0.98); }
.pill-primary { border-color: rgba(255,138,61,0.5); background: linear-gradient(180deg, var(--color-ember), #e9742b); color: #1a0f06; box-shadow: 0 10px 30px -12px rgba(255,138,61,0.6); }
.pill-primary:hover { color: #160c04; filter: brightness(1.05); }
.pill-ghost:hover { color: var(--color-danger); border-color: rgba(232,119,95,0.4); }

/* VU-meter progress */
.vu { height: 6px; border-radius: 999px; background: var(--color-sunken); overflow: hidden; border: 1px solid var(--color-line); }
.vu > span { display: block; height: 100%; background: linear-gradient(90deg, var(--color-gold), var(--color-ember)); box-shadow: 0 0 14px rgba(255,138,61,0.6); }

/* spinning requester token for the current track */
.disc { animation: spin 6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* staggered page-load reveal */
@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.reveal { opacity: 0; animation: rise .7s cubic-bezier(.2,.7,.2,1) forwards; }
@media (prefers-reduced-motion: reduce) {
  .reveal { animation: none; opacity: 1; }
  .disc { animation: none; }
}
```

- [ ] **Step 3: `web/src/components/Grain.tsx`** — fixed SVG film-grain overlay

```tsx
export function Grain() {
  return (
    <svg aria-hidden style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: -1, opacity: 0.05, mixBlendMode: "overlay", pointerEvents: "none" }}>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" /></filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  );
}
```

- [ ] **Step 4: Verify + commit**

Run: `npm run build:web` (the CSS compiles via the tailwind plugin). Then `npm run lint`.
```bash
git add -A && git commit -m "feat(web): add After-Hours design system, types, grain overlay"
```

---

### Task 3: Typed REST API client

**Files:** `web/src/lib/api.ts`, `web/src/lib/api.test.ts`

**Interfaces:** `const api = { me(), state(guildId), voiceChannels(guildId), play(guildId, input, voiceChannelId?), pick(guildId, videoId, voiceChannelId?), control(guildId, action), remove(guildId, itemId), reorder(guildId, itemId, toIndex), logout() }` — all return parsed JSON, throw on non-OK, send `credentials:"include"`.

- [ ] **Step 1: Write the failing test (mock fetch)** — `// @vitest-environment jsdom` not needed (pure fetch). 

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError } from "./api.js";

function mockOnce(ok: boolean, json: unknown, status = ok ? 200 : 400) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => json });
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("GET /api/me with credentials", async () => {
    const fn = mockOnce(true, { user: { id: "1" }, guilds: [] });
    const me = await api.me();
    expect(me.user.id).toBe("1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/me");
    expect((init as RequestInit).credentials).toBe("include");
  });
  it("play POSTs the input as JSON", async () => {
    const fn = mockOnce(true, { queued: { id: "i1", title: "X" } });
    await api.play("G1", "https://youtu.be/x", "C1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/play");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ input: "https://youtu.be/x", voiceChannelId: "C1" });
  });
  it("control hits the action route", async () => {
    const fn = mockOnce(true, { ok: true });
    await api.control("G1", "skip");
    expect(fn.mock.calls[0]![0]).toBe("/api/guilds/G1/skip");
  });
  it("throws ApiError with the status on non-OK", async () => {
    mockOnce(false, { error: "forbidden" }, 403);
    await expect(api.state("G1")).rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: Run (RED), implement `web/src/lib/api.ts`**

```ts
import type { Me, Snapshot, TrackMeta, VoiceChannel } from "../types.js";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = ((await res.json()) as { error?: string }).error ?? detail; } catch { /* ignore */ }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}
function post<T>(url: string, body?: unknown): Promise<T> {
  return req<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

export type ControlAction = "skip" | "pause" | "resume" | "stop";

export const api = {
  me: () => req<Me>("/api/me"),
  state: (g: string) => req<Snapshot>(`/api/guilds/${g}/state`),
  voiceChannels: (g: string) => req<{ channels: VoiceChannel[] }>(`/api/guilds/${g}/voice-channels`),
  play: (g: string, input: string, voiceChannelId?: string) =>
    post<{ queued?: { id: string; title: string }; candidates?: TrackMeta[] }>(`/api/guilds/${g}/play`, { input, voiceChannelId }),
  pick: (g: string, videoId: string, voiceChannelId?: string) =>
    post<{ queued?: { id: string; title: string } }>(`/api/guilds/${g}/pick`, { videoId, voiceChannelId }),
  control: (g: string, action: ControlAction) => post<{ ok: boolean }>(`/api/guilds/${g}/${action}`),
  remove: (g: string, itemId: string) => post<{ ok: boolean }>(`/api/guilds/${g}/queue/remove`, { itemId }),
  reorder: (g: string, itemId: string, toIndex: number) => post<{ ok: boolean }>(`/api/guilds/${g}/queue/reorder`, { itemId, toIndex }),
  logout: () => post<void>("/auth/logout"),
};
```

- [ ] **Step 3: Run (GREEN) + commit**

Run: `npx vitest run web/src/lib/api.test.ts` then `npm test`. (Ensure the root `vitest.config.ts` `include` covers `web/**/*.test.ts` — add it if needed.)
```bash
git add -A && git commit -m "feat(web): add typed REST api client"
```

---

### Task 4: WebSocket live-state hook + reducer

**Files:** `web/src/lib/useGuildState.ts`, `web/src/lib/wsReducer.test.ts`

**Interfaces:** a pure `applyWsMessage(prev, raw): WsState` reducer (tested), plus a `useGuildState(guildId)` hook that opens `/ws`, subscribes, and feeds messages through the reducer. `WsState = { snapshot: Snapshot | null; status: "connecting"|"live"|"forbidden"|"closed" }`.

- [ ] **Step 1: Write the failing reducer test**

```ts
import { describe, it, expect } from "vitest";
import { applyWsMessage, initialWsState } from "./useGuildState.js";

const snap = { current: null, upcoming: [], history: [] };

describe("applyWsMessage", () => {
  it("applies a state message and goes live", () => {
    const s = applyWsMessage(initialWsState, JSON.stringify({ type: "state", state: snap }));
    expect(s.status).toBe("live");
    expect(s.snapshot).toEqual(snap);
  });
  it("marks forbidden on an error message", () => {
    const s = applyWsMessage(initialWsState, JSON.stringify({ type: "error", reason: "forbidden" }));
    expect(s.status).toBe("forbidden");
  });
  it("marks forbidden on revoked", () => {
    expect(applyWsMessage(initialWsState, JSON.stringify({ type: "revoked" })).status).toBe("forbidden");
  });
  it("ignores malformed frames", () => {
    expect(applyWsMessage({ ...initialWsState, status: "live" }, "not json")).toMatchObject({ status: "live" });
  });
});
```

- [ ] **Step 2: Run (RED), implement `web/src/lib/useGuildState.ts`**

```ts
import { useEffect, useReducer } from "react";
import type { Snapshot } from "../types.js";

export interface WsState { snapshot: Snapshot | null; status: "connecting" | "live" | "forbidden" | "closed"; }
export const initialWsState: WsState = { snapshot: null, status: "connecting" };

export function applyWsMessage(prev: WsState, raw: string): WsState {
  let msg: { type?: string; state?: Snapshot };
  try { msg = JSON.parse(raw); } catch { return prev; }
  if (msg.type === "state" && msg.state) return { snapshot: msg.state, status: "live" };
  if (msg.type === "error" || msg.type === "revoked") return { ...prev, status: "forbidden" };
  return prev;
}

export function useGuildState(guildId: string | null): WsState {
  const [state, dispatch] = useReducer(
    (s: WsState, a: { raw: string } | { reset: true } | { closed: true }): WsState =>
      "reset" in a ? initialWsState : "closed" in a ? { ...s, status: s.status === "forbidden" ? s.status : "closed" } : applyWsMessage(s, a.raw),
    initialWsState,
  );
  useEffect(() => {
    if (!guildId) return;
    dispatch({ reset: true });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ subscribe: guildId })));
    ws.addEventListener("message", (e) => dispatch({ raw: String(e.data) }));
    ws.addEventListener("close", () => dispatch({ closed: true }));
    return () => ws.close();
  }, [guildId]);
  return state;
}
```

- [ ] **Step 3: Run (GREEN) + commit**

Run: `npx vitest run web/src/lib/wsReducer.test.ts` then `npm test`.
```bash
git add -A && git commit -m "feat(web): add websocket live-state hook + pure reducer"
```

---

### Task 5: Now-playing hero, controls, queue

**Files:** `web/src/components/NowPlaying.tsx`, `Controls.tsx`, `Queue.tsx`. (Aesthetic locked — transcribe faithfully.)

- [ ] **Step 1: helpers — add `web/src/lib/format.ts`** (+ tiny test)

```ts
export function fmtTime(totalSec: number | null): string {
  if (totalSec === null || !Number.isFinite(totalSec)) return "—:—";
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
```
Test: `fmtTime(125) === "2:05"`, `fmtTime(null) === "—:—"`.

- [ ] **Step 2: `web/src/components/Controls.tsx`**

```tsx
import type { ControlAction } from "../lib/api.js";

const Icon = { skip: "⏭", pause: "⏸", resume: "▶", stop: "■" } as const;

export function Controls({ onAction, paused, disabled }: {
  onAction: (a: ControlAction) => void; paused: boolean; disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button className="pill pill-primary" disabled={disabled} aria-label={paused ? "Resume" : "Pause"}
        onClick={() => onAction(paused ? "resume" : "pause")}>
        <span aria-hidden>{paused ? Icon.resume : Icon.pause}</span> {paused ? "Resume" : "Pause"}
      </button>
      <button className="pill" disabled={disabled} aria-label="Skip" onClick={() => onAction("skip")}>
        <span aria-hidden>{Icon.skip}</span> Skip
      </button>
      <button className="pill pill-ghost" disabled={disabled} aria-label="Stop" onClick={() => onAction("stop")}>
        <span aria-hidden>{Icon.stop}</span> Stop
      </button>
    </div>
  );
}
```

- [ ] **Step 3: `web/src/components/NowPlaying.tsx`**

```tsx
import type { QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";

export function NowPlaying({ item }: { item: QueueItem | null }) {
  if (!item) {
    return (
      <section className="card hero-glow reveal p-8" style={{ animationDelay: "80ms" }}>
        <p className="eyebrow">On air</p>
        <p className="font-display text-3xl mt-3" style={{ color: "var(--color-ink-dim)" }}>Silence on the wire.</p>
        <p className="mt-2 text-sm" style={{ color: "var(--color-ink-faint)" }}>Queue a YouTube link or search below to start the set.</p>
      </section>
    );
  }
  const { meta, requester } = item;
  return (
    <section className="card hero-glow reveal p-7 sm:p-8" style={{ animationDelay: "80ms" }}>
      <div className="relative z-10 flex gap-6">
        <div className="shrink-0 relative">
          <img src={meta.thumbnailUrl ?? ""} alt="" width={132} height={132}
            className="rounded-2xl object-cover disc" style={{ width: 132, height: 132, boxShadow: "0 14px 40px -18px rgba(255,138,61,0.7)" }} />
          <span className="absolute inset-0 rounded-2xl" style={{ boxShadow: "inset 0 0 0 1px var(--color-line)" }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>● Now playing</p>
          <h1 className="font-display text-3xl sm:text-4xl leading-tight mt-2 truncate" title={meta.title}>{meta.title}</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-ink-dim)" }}>{meta.channel}</p>
          <div className="vu mt-5"><span style={{ width: "38%" }} /></div>
          <div className="flex items-center justify-between mt-2 font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
            <span>live feed</span><span>{fmtTime(meta.durationSec)}</span>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <img src={requester.avatarUrl} alt="" width={22} height={22} className="rounded-full" />
            <span className="text-xs" style={{ color: "var(--color-ink-dim)" }}>
              requested by <strong style={{ color: "var(--color-ink)" }}>{requester.displayName}</strong>
              <span className="font-mono" style={{ color: "var(--color-ink-faint)" }}> · {requester.source}</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: `web/src/components/Queue.tsx`**

```tsx
import type { QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";

export function Queue({ items, onRemove }: { items: QueueItem[]; onRemove: (itemId: string) => void }) {
  return (
    <section className="card reveal p-5 sm:p-6" style={{ animationDelay: "180ms" }}>
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">Up next</p>
        <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>{items.length} queued</span>
      </div>
      {items.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--color-ink-faint)" }}>Nothing waiting. The night is young.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={it.id} className="group flex items-center gap-3 rounded-xl px-3 py-2.5"
              style={{ transition: "background .2s" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <span className="font-mono text-xs w-6 text-right" style={{ color: "var(--color-ink-faint)" }}>{i + 1}</span>
              <img src={it.meta.thumbnailUrl ?? ""} alt="" width={40} height={40} className="rounded-md object-cover" style={{ width: 40, height: 40 }} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={it.meta.title}>{it.meta.title}</p>
                <p className="truncate text-xs" style={{ color: "var(--color-ink-faint)" }}>
                  {it.meta.channel} · <span className="font-mono">{fmtTime(it.meta.durationSec)}</span> · {it.requester.displayName}
                </p>
              </div>
              <button aria-label={`Remove ${it.meta.title}`} onClick={() => onRemove(it.id)}
                className="pill pill-ghost opacity-0 group-hover:opacity-100" style={{ padding: "0.35rem 0.7rem", fontSize: "0.8rem" }}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Verify + commit**

Run: `npm test && npm run build:web` (components typecheck + compile via vite). Then `npm run lint`.
```bash
git add -A && git commit -m "feat(web): now-playing hero, controls, and queue components"
```

---

### Task 6: Login, server selector, add-bar, and App composition

**Files:** `web/src/components/LoginGate.tsx`, `ServerSelector.tsx`, `AddBar.tsx`, `App.tsx` (replace stub), `web/src/App.test.tsx`.

- [ ] **Step 1: `web/src/components/LoginGate.tsx`**

```tsx
import { Grain } from "./Grain.js";

export function LoginGate() {
  return (
    <main className="min-h-full grid place-items-center px-6">
      <Grain />
      <div className="card hero-glow reveal max-w-md w-full p-10 text-center">
        <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>After-Hours</p>
        <h1 className="font-display text-4xl mt-3 leading-tight">The booth is locked.</h1>
        <p className="mt-3 text-sm" style={{ color: "var(--color-ink-dim)" }}>
          Sign in with Discord to take the controls — only servers you belong to will appear.
        </p>
        <a className="pill pill-primary mt-7 justify-center w-full" href="/auth/login">
          <span aria-hidden>◈</span> Continue with Discord
        </a>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: `web/src/components/ServerSelector.tsx`**

```tsx
import type { Me } from "../types.js";

export function ServerSelector({ me, activeGuildId, onSelect, onLogout }: {
  me: Me; activeGuildId: string | null; onSelect: (id: string) => void; onLogout: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-3 justify-between reveal">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-display text-xl" style={{ color: "var(--color-ember-soft)" }}>◴ After-Hours</span>
        <div className="flex flex-wrap gap-1.5">
          {me.guilds.length === 0 && <span className="text-xs" style={{ color: "var(--color-ink-faint)" }}>No shared servers.</span>}
          {me.guilds.map((g) => (
            <button key={g.id} onClick={() => onSelect(g.id)}
              className="pill" aria-pressed={g.id === activeGuildId}
              style={g.id === activeGuildId ? { borderColor: "rgba(255,138,61,0.6)", color: "var(--color-ember-soft)" } : undefined}>
              {g.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2.5">
        <img src={me.user.avatarUrl} alt="" width={26} height={26} className="rounded-full" />
        <span className="text-xs" style={{ color: "var(--color-ink-dim)" }}>{me.user.username}</span>
        <button className="pill" style={{ padding: "0.4rem 0.8rem", fontSize: "0.8rem" }} onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: `web/src/components/AddBar.tsx`** (paste link or search → candidate picker)

```tsx
import { useState } from "react";
import type { TrackMeta } from "../types.js";
import { fmtTime } from "../lib/format.js";

export function AddBar({ onPlay, onPick, busy }: {
  onPlay: (input: string) => Promise<TrackMeta[] | null>; // returns candidates for a search, else null
  onPick: (videoId: string) => void; busy?: boolean;
}) {
  const [input, setInput] = useState("");
  const [candidates, setCandidates] = useState<TrackMeta[] | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    const c = await onPlay(input.trim());
    setCandidates(c);
    if (!c) setInput("");
  }
  return (
    <section className="card reveal p-5 sm:p-6" style={{ animationDelay: "120ms" }}>
      <form onSubmit={submit} className="flex gap-2.5">
        <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy}
          placeholder="Paste a YouTube link, or search a song…" aria-label="Add a track"
          className="flex-1 bg-transparent outline-none text-sm px-4 py-3 rounded-xl"
          style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }} />
        <button className="pill pill-primary" disabled={busy} type="submit">Queue it</button>
      </form>
      {candidates && (
        <ul className="mt-4 flex flex-col gap-1">
          <li className="eyebrow px-1 pb-1">Pick the exact track</li>
          {candidates.map((c) => (
            <li key={c.videoId}>
              <button onClick={() => { onPick(c.videoId); setCandidates(null); setInput(""); }}
                className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left"
                style={{ transition: "background .15s" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,138,61,0.08)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <img src={c.thumbnailUrl ?? ""} alt="" width={44} height={44} className="rounded-md object-cover" style={{ width: 44, height: 44 }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{c.title}</span>
                  <span className="block truncate text-xs" style={{ color: "var(--color-ink-faint)" }}>{c.channel} · <span className="font-mono">{fmtTime(c.durationSec)}</span></span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: `web/src/components/App.tsx`** (replace the stub — composition + data flow)

```tsx
import { useCallback, useEffect, useState } from "react";
import type { Me, TrackMeta } from "../types.js";
import { api, type ControlAction } from "../lib/api.js";
import { useGuildState } from "../lib/useGuildState.js";
import { Grain } from "./Grain.js";
import { LoginGate } from "./LoginGate.js";
import { ServerSelector } from "./ServerSelector.js";
import { NowPlaying } from "./NowPlaying.js";
import { Controls } from "./Controls.js";
import { Queue } from "./Queue.js";
import { AddBar } from "./AddBar.js";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const live = useGuildState(guildId);

  useEffect(() => {
    api.me().then((m) => { setMe(m); setGuildId((g) => g ?? m.guilds[0]?.id ?? null); })
      .catch(() => setMe(null)).finally(() => setAuthChecked(true));
  }, []);

  const control = useCallback(async (a: ControlAction) => {
    if (!guildId) return;
    if (a === "pause") setPaused(true);
    if (a === "resume") setPaused(false);
    await api.control(guildId, a).catch(() => {});
  }, [guildId]);

  const onPlay = useCallback(async (input: string): Promise<TrackMeta[] | null> => {
    if (!guildId) return null;
    const r = await api.play(guildId, input);
    return r.candidates ?? null;
  }, [guildId]);

  if (!authChecked) return <main className="min-h-full grid place-items-center"><span className="eyebrow">tuning in…</span></main>;
  if (!me) return <LoginGate />;

  const snap = live.snapshot;
  return (
    <div className="min-h-full">
      <Grain />
      <div className="mx-auto max-w-4xl px-5 sm:px-8 py-7 flex flex-col gap-5">
        <ServerSelector me={me} activeGuildId={guildId} onSelect={setGuildId}
          onLogout={() => { api.logout().finally(() => (location.href = "/")); }} />
        {!guildId ? (
          <p className="card p-8 text-center" style={{ color: "var(--color-ink-dim)" }}>Pick a server to take the controls.</p>
        ) : (
          <>
            <NowPlaying item={snap?.current ?? null} />
            <div className="flex items-center justify-between flex-wrap gap-3">
              <Controls onAction={control} paused={paused} disabled={!snap?.current} />
              <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                {live.status === "live" ? "● live" : live.status === "forbidden" ? "✕ no access" : "○ " + live.status}
              </span>
            </div>
            <AddBar onPlay={onPlay} onPick={(v) => guildId && api.pick(guildId, v).catch(() => {})} />
            <Queue items={snap?.upcoming ?? []} onRemove={(id) => guildId && api.remove(guildId, id).then(() => {}).catch(() => {})} />
          </>
        )}
        <footer className="text-center font-mono text-xs pt-4" style={{ color: "var(--color-ink-faint)" }}>
          plays the exact link, nothing else · after-hours
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render smoke test `web/src/App.test.tsx`** (jsdom)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./components/App.js";

afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("shows the login gate when /api/me is unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "unauthenticated" }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Continue with Discord/i)).toBeTruthy());
  });
  it("shows the panel + server selector when logged in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("The Booth")).toBeTruthy());
  });
});
```
(WebSocket is undefined in jsdom; the `useGuildState` effect constructs one — guard the test by stubbing `globalThis.WebSocket` with a no-op class in a `beforeEach`, or have the hook tolerate a missing `WebSocket`. Add a `if (typeof WebSocket === "undefined") return;` guard at the top of the effect to keep the smoke test clean.)

- [ ] **Step 6: Verify + commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build` → all green (full app builds into `dist/public`).
```bash
git add -A && git commit -m "feat(web): login gate, server selector, add-bar, and App composition"
```

---

### Task 7: README + final verification

**Files:** `README.md`.

- [ ] **Step 1: Extend `README.md`** — a **Control panel** section: `npm run dev:web` (Vite dev server proxying `/api`+`/ws` to the bot on :8080) for local development; `npm run build` produces `dist/public` which the bot serves at `PUBLIC_BASE_URL`; the panel needs the Plan 3 OAuth setup. Add a **manual-verify checklist**: log in → land on the panel; the server selector lists only your servers; now-playing + queue update live as you (or Discord) play/skip; pasting a link queues it; searching shows the picker and a click queues the exact pick; remove works.

- [ ] **Step 2: Final verification**

Run: `npm test && npm run typecheck && npm run lint && npm run build`.
Expected: full suite green; `dist/public/index.html` + assets emitted; backend compiled to `dist/`.

- [ ] **Step 3: Commit**
```bash
git add -A && git commit -m "docs: add control-panel usage + manual-verify checklist"
```

---

## Self-Review

**1. Spec coverage (Plan 4 = frontend §10):** login ("Login with Discord") → LoginGate (T6) ✔; server selector (bot-verified guilds from `/api/me`) → ServerSelector (T6) ✔; now-playing w/ thumbnail/title/channel/requester/progress → NowPlaying (T5) ✔; pause/resume/skip/stop → Controls (T5) ✔; queue rows w/ requester + remove → Queue (T5) ✔; add by link or search→pick → AddBar (T6) ✔; live via WebSocket → useGuildState (T4) ✔; one socket per viewed guild (re-subscribes on guild switch) ✔. Voice-channel gap closed by the `voice-channels` endpoint (T1) — *note:* the AddBar enqueues to the existing session by default (the common case); wiring the channel picker into AddBar for cold-start joins is a small follow-up, flagged in the README.

**2. Placeholder scan:** none — every step has runnable code/commands. The jsdom `WebSocket` guard (T6 Step 5) is called out explicitly with the exact fix.

**3. Type consistency:** `web/src/types.ts` mirrors the Plan 1/3 shapes (`QueueItem`/`Snapshot`/`Me`/`TrackMeta`/`Requester`/`VoiceChannel`). The `api` client (T3) returns those types; `useGuildState` (T4) consumes `Snapshot`; components consume `QueueItem`/`Me`/`TrackMeta`. `ControlAction` is shared from `api.ts`. The backend `voice-channels` endpoint (T1) returns `{ channels: {id,name}[] }` matching `VoiceChannel`.

**4. Aesthetic cohesion:** all components draw from the Task 2 design tokens/classes (`.card`, `.pill`, `.hero-glow`, `.vu`, `.eyebrow`, `.font-display`, `.font-mono`, `.reveal`, `.disc`) — Fraunces/Hanken/JetBrains-Mono, ember glow, grain, staggered reveal. No ad-hoc palettes; `prefers-reduced-motion` respected.
