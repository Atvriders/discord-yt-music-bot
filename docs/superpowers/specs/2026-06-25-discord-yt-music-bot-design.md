# discord-yt-music-bot — Design Spec

- **Date:** 2026-06-25
- **Status:** Approved design, revised after multi-agent adversarial review (v2), pending implementation plan
- **Owner:** Atvriders

## 1. Summary

A Discord music bot that plays audio **only** from the exact YouTube link it is
given — it never substitutes an "equivalent" video. It accepts links (and, for
convenience, song-name searches that the requester explicitly resolves to a
single video) via a `?`-prefixed chat command in Discord, and via a web control
panel. The web panel shows what is currently playing, the queue, and who
requested each track, and lets authorized users add and control playback. Users
authenticate to the panel with Discord OAuth2 so every request is attributed to
a real Discord identity.

> **v2 note:** This revision incorporates a 5-dimension adversarial review
> (deployment, architecture, auth/security, YouTube-extraction, voice/audio).
> The biggest changes address 2026-current realities that the v1 design missed:
> Discord **DAVE** voice E2EE, **AEAD** voice encryption, YouTube **datacenter-IP
> blocking / PO-token / SABR / nsig-JS-runtime** requirements, OAuth **state**
> CSRF protection, **bot-verified** authorization, and **Opus passthrough**.

## 2. Goals / Non-Goals

### Goals
- Play audio from a **specific** YouTube video, chosen by the requester. Direct
  URLs always play that exact video.
- Highest practical audio quality (Opus **passthrough** of the source when
  possible; otherwise best-source transcode at the max bitrate Discord allows).
- `?`-prefixed Discord commands to queue links/searches and control playback.
- Web control panel: live now-playing + queue, full playback control, add by
  link or search, **requester attribution**.
- Discord OAuth2 login for the panel; control gated by **bot-verified** server
  membership / admin allowlist.
- Multi-server: one bot instance serves many Discord servers, each with an
  independent voice session and queue.
- One-container deployment; image built by GitHub Actions to GHCR; configured
  entirely via environment variables in `docker-compose`.

### Non-Goals (YAGNI)
- No "find me a song like X" / auto-substitution of an equivalent video.
- No support for non-YouTube sources (Spotify, SoundCloud, direct files).
- No full database in v1. **Exception (changed in v2):** a minimal **active
  session snapshot** is persisted to a JSON file on the cache volume so a
  routine redeploy/restart resumes instead of dropping every listener (§4,
  §11). Long-tail play history remains in-memory, bounded, and is lost on
  restart.
- No playlist import in v1 (single video per request; playlist URLs play only
  their `v=` video via `--no-playlist`). Possible follow-up.
- No horizontal scaling / multi-instance sharding — single process.

### Legal / ToS caveat
Downloading YouTube audio server-side via yt-dlp may violate YouTube's Terms of
Service. yt-dlp itself is a neutral, legal tool, but the download act can breach
the contract (remedy is IP/account blocking, not criminal). This is a
**self-host-at-your-own-risk** tool for personal/private servers, not a public
service. This framing also motivates the residential-IP recommendation in §5.1.

## 3. The Exact-Link Rule (core behavior)

| Input type | Behavior |
|---|---|
| A YouTube video URL | Validate it resolves to a real, playable video, then queue **that exact video**. Never substituted. |
| A non-URL text query (song name) | Run a YouTube search, present the top ~5 results (title, channel, duration) as button choices. **Only the video the requester picks is queued.** No automatic pick. |
| A non-YouTube URL | Rejected with a friendly "YouTube links only" message. |

### 3.1 URL parsing (canonical video-id extraction)
The parser must extract the canonical `videoId` from **all** of these and ignore
extra params, then resolve only that single video:
- `youtube.com/watch?v=ID` (with `&t=`, `&si=`, `&feature=` stripped)
- `youtu.be/ID`, `youtube.com/shorts/ID`, `youtube.com/embed/ID`,
  `youtube.com/live/ID`
- `music.youtube.com/watch?v=ID`, `m.youtube.com/...`
- `watch?v=ID&list=PL...` → extract `v=ID`, **ignore the playlist**, and call
  yt-dlp with `--no-playlist`.
- A bare playlist URL with **no** `v=` → reject in v1 (matches the no-playlist
  non-goal).

The search path is the *only* place a name maps to a video, and it always
requires an explicit human choice. The bot never auto-selects.

## 4. Architecture

Single TypeScript/Node process containing the Discord bot, the HTTP/WebSocket
API, and the static frontend. One process keeps the queue as a single source of
truth with no cross-process sync. **The single-process choice has one fate**, so
§11 adds the guards (subprocess concurrency cap, top-level crash handlers,
graceful shutdown) that make it safe.

```
                ┌──────────────────────── Node process ───────────────────────┐
 Discord  ◄────►│ discord/  youtube/  voice/  queue/(pure) orchestrator/       │
 gateway        │ (? cmds,  (yt-dlp   (per-   (state +       (on trackEnd →     │
                │  buttons)  wrap)     guild   mutations,     advance → prefetch│
                │                      conn +  events,        download → play)  │
                │                      player) async-mutex,                     │
                │                              stable ids)                      │
                │   cache/(LRU)   auth/(OAuth2+state, sessions, canControl)     │
                │   server/ (fastify REST + ws, rate-limit)  serves web/        │
                └──────────────────────────────┬──────────────────────────────┘
                                                │ REST + WebSocket
                                          Browser (React panel)
```

### Components (each isolated, single-purpose, testable)

- **`youtube/`** — wraps the `yt-dlp` binary as a subprocess (see §5 for the
  2026 extraction requirements).
  - `resolve(url): Promise<TrackMeta>` — validate a URL is a real playable
    video; return `{ videoId, title, channel, durationSec, isLive,
    thumbnailUrl }`. Rejects private/age-restricted/unavailable/live/non-video/
    over-long URLs and SABR/PO-token "no playable audio" with **typed** errors.
  - `search(query, limit=5): Promise<TrackMeta[]>` — `ytsearch{limit}:query`.
    Uses flat extraction for speed; **may** return `N/A` for channel/duration —
    the picker tolerates missing fields, and a full `resolve()` happens only on
    the chosen video.
  - `download(videoId): Promise<string>` — fetch best audio to the cache, return
    the local file path. Idempotent. Honors `--max-filesize`,
    `MAX_TRACK_DURATION_SEC`, and a download timeout; surfaces `ENOSPC` as a
    typed error.
  - Pure interface over a subprocess → unit-tested with the subprocess mocked.

- **`cache/`** — on-disk audio cache at `CACHE_DIR`, keyed by `videoId`,
  LRU-evicted by total size (`CACHE_MAX_MB`). **Pin** items referenced by any
  guild's `current`/`upcoming` so a still-queued track is never evicted (evict
  only history-only items).

- **`voice/`** — per-guild voice session. Join/leave, hold a `@discordjs/voice`
  `AudioPlayer`; `play(resource)`, `pause`, `resume`, `skip`, `stop`. Emits
  `trackStart`/`trackEnd`/`idle`/`error`. Auto-reconnect on transient
  disconnect; auto-leave after `IDLE_TIMEOUT_SEC` of an empty queue. **DAVE +
  AEAD encryption** per §5.3.

- **`queue/` (pure)** — per-guild queue **state only**: `current`,
  `upcoming[]`, bounded `history[]` (`HISTORY_MAX_ITEMS` ring buffer). Mutations
  `add/remove/reorder/clear/skip/advance` operate on **stable item IDs**, run
  through a **per-guild async mutex** (no mutation observes a half-applied
  state; `advance()` and user `skip()` cannot consume the same `current`), and
  emit a `changed` event plus a `needPrefetch(nextVideoId)` event. Fully unit
  testable — it performs **no I/O**.

- **`orchestrator/`** — subscribes to queue + voice events and performs the I/O:
  on `needPrefetch` → `youtube.download`; on `trackEnd`/`advance` →
  `voice.play(file)`. This is the component that owns "on trackEnd → advance →
  download if needed → play," keeping `queue/` pure.

- **`discord/`** — Discord gateway client + `?` command parser + button-based
  search picker. Translates chat into orchestrator/queue/voice operations.

- **`auth/`** — Discord OAuth2 login with `state` CSRF protection (§7), session
  management, and the **bot-verified** authorization predicate
  `canControl(user, guildId)`.

- **`server/`** — fastify REST + `ws` broadcaster (all keyed by `guildId`),
  per-user/per-guild rate limiting, a `/healthz` endpoint, and serves the built
  frontend.

- **`web/`** — React + Vite + Tailwind control panel.

### 4.1 Active-session snapshot (durable, no DB)
On every debounced queue `changed`, persist per-guild
`{ voiceChannelId, current{videoId,positionSec}, upcoming[], requesters }` to a
single JSON file under `CACHE_DIR`. On boot, rejoin channels and resume. ~50
lines, no database. Turns a redeploy from "everyone dropped mid-song" into a
brief reconnect.

## 5. YouTube Extraction & Audio Pipeline (2026 reality)

### 5.1 Server-side YouTube access (feasibility-critical)
YouTube in 2026 actively degrades server/datacenter access. The design must
treat this as first-class, not assume `yt-dlp` "just works":
- **Datacenter IP blocking:** cloud/VPS IPs frequently hit "Sign in to confirm
  you're not a bot", HTTP 403/429, or SABR-only/"only images" responses
  (~20–40% success vs ~85–95% residential). **Chosen target: home/residential
  network** (§15), so **direct access is the default path** and the proxy/
  cookies/PO-token mitigations below are wired but **off by default**, used only
  if the home IP is ever flagged.
- **External JS runtime required for nsig/n-challenge:** yt-dlp needs Deno or
  Node to solve YouTube's signature challenge; the **standalone binary omits the
  EJS solver scripts**. We therefore install **`pip install yt-dlp[default]`**
  and ship **Deno** (preferred, sandboxed) in the image; Node is a fallback.
- **PO tokens / SABR:** some clients/IPs require a PO token or get only
  storyboard images. Mitigations (as config): choose low-friction clients via
  `--extractor-args youtube:player_client=...` (e.g. `android_vr`,
  `web_embedded`, `tv_simply`), and optionally run a **bgutil PO-token provider
  sidecar** (`Brainicism/bgutil-ytdlp-pot-provider`, `:4416`) toggled by
  `PO_TOKEN_PROVIDER_URL`.
- **Config knobs:** `YT_PROXY`, `YT_COOKIES` (mounted cookies file),
  `PO_TOKEN_PROVIDER_URL`, plus jittered exponential-backoff retry on
  403/429. Resolve/download failures degrade to a friendly message (§11).

### 5.2 Audio path & "highest quality" (Opus passthrough)
1. **Prefer passthrough:** select an Opus source with
   `-f 'bestaudio[acodec=opus]/bestaudio/best'` `--no-playlist`. YouTube's
   bestaudio is usually already 48 kHz Opus (itags 251/250/249).
2. **Passthrough path (quality-optimal, low CPU):** feed the Ogg/WebM-Opus
   stream to `createAudioResource` with `inputType:
   StreamType.WebmOpus`/`OggOpus` and **`inlineVolume: false`** — **no ffmpeg
   re-encode** (avoids generation loss + CPU). On this path there is **no
   encoder object**, so bitrate is governed by the source; you **cannot**
   `setBitrate`.
3. **Transcode fallback (non-Opus sources only):** ffmpeg → PCM →
   `@discordjs/opus`. **Only here** can you `resource.encoder.setBitrate(...)`
   and `setFEC(true)`; set it from the live channel bitrate (§5.4).
4. Reject `isLive` videos (download-to-cache can't complete) with a typed error.
5. **Optional loudness normalization** (`NORMALIZE_LOUDNESS`): EBU R128
   (`ffmpeg loudnorm`, target ~ -14 LUFS). Note: enabling it forces the
   transcode path (loses passthrough). Default **off**.

> The v1 spec's "transcode every track to Opus and let the encoder set the
> channel bitrate" was self-contradictory: passthrough has no encoder to set
> bitrate on, and transcoding already-Opus audio is a lossy double-encode. v2
> resolves this: passthrough by default, transcode only as a fallback.

### 5.3 Voice connection: DAVE + AEAD encryption (mandatory in 2026)
- **DAVE E2EE** is enforced on all non-stage voice channels since **2026-03-02**.
  Pin **`@discordjs/voice` ≥ 0.19.2** (bundles `@snazzah/davey`; audio *send*
  — what a music bot does — is supported). Avoid the known 0.19.x reconnect/
  receive bugs by smoke-testing the pinned patch.
- **Encryption mode:** legacy `xsalsa20_poly1305*` was removed 2024-11-18.
  `@discordjs/voice` auto-negotiates `aead_aes256_gcm_rtpsize` (preferred) or
  `aead_xchacha20_poly1305_rtpsize` (always available). Ship a capable crypto
  lib in the image: **`@noble/ciphers`** (pure JS, no native build — best for a
  slim image) or `sodium-native`.
- **Opus encoder:** pin **`@discordjs/opus`** (used on the transcode-fallback
  path; unused on passthrough).

### 5.4 Bitrate ceilings (read live)
Exact per-tier Opus ceilings: none 96 000, Boost L1 128 000, L2 256 000,
L3/VIP 384 000, stage 64 000. The bot reads `VoiceChannel.bitrate` at join time
(reflects the server's boost + per-channel setting). On the transcode path, set
encoder bitrate = channel bitrate + FEC. On passthrough, you cannot exceed the
source's own bitrate regardless of channel headroom — state this honestly.

## 6. Discord Command Interface (`?` prefix)

Requires the **Message Content** and **Guild Voice States** privileged/standard
intents (Message Content for `?` commands; Voice States to read the author's
current voice channel for §6.1). **Note:** Message Content needs bot
verification + intent approval beyond **100 guilds** — a v1 scope ceiling.
Slash-command equivalents (`/play` …) are a possible future addition that avoid
the privileged intent.

| Command | Action |
|---|---|
| `?play <url\|query>` / `?<url\|query>` | URL → queue exact video; query → search + button picker |
| `?skip` | Skip current track |
| `?pause` / `?resume` | Pause / resume |
| `?stop` | Stop and clear the queue |
| `?queue` | Show the queue with requesters |
| `?np` | Now playing (title, requester, progress) |
| `?remove <n>` | Remove a queue item (resolved to its stable id) |
| `?help` | Command list |

Search results are **button components** (not reactions); clicking queues that
specific video, attributed to the clicker.

### 6.1 Voice-channel selection (was unspecified)
- **Discord request:** the bot joins the **command author's current** voice
  channel; if they're in none, it replies with an error.
- **Web request:** the request must carry a `voiceChannelId`; the panel lets the
  user pick among the guild's voice channels (or reads their current voice state
  via Voice States). Error if none chosen.
- **Already playing in another channel** in that guild: reject by default;
  moving channels is **admin-only**.

## 7. Authentication & Authorization (web)

### 7.1 Login (OAuth2 with CSRF protection)
Discord OAuth2, scopes `identify` + `guilds`. At `GET /auth/login` generate a
**cryptographically random, single-use, time-bounded `state`** bound to the
pre-auth session; at `GET /auth/callback` reject unless `state` matches and is
unconsumed (defense against login-CSRF / fixation). Optional PKCE as
defense-in-depth. Code exchange is **server-side over TLS** using the client
id/secret; **verify the granted scope actually includes `identify`+`guilds`**
(Discord may grant narrower) and reject otherwise; treat the code as single-use.

### 7.2 Sessions
Use a **server-side session** (opaque random session id in the cookie) — or an
**AEAD-encrypted** cookie — **never** a plaintext signed blob, and **do not**
store the guild list in the cookie (it's a privacy leak and goes stale).
Cookie attributes are mandatory: `HttpOnly`, `Secure` (HTTPS in prod),
`SameSite=Lax` (Strict for control actions), explicit `Max-Age`/absolute
expiry, `Path=/`. **Rotate** the session id on login (anti-fixation).
`POST /auth/logout` deletes the **server-side** session (true invalidation) and
revokes the Discord token; idle + absolute timeouts apply.

### 7.3 Authorization — `canControl(user, guildId)` (bot-verified)
The authoritative source is the **bot's own gateway membership/role state**, not
the user's self-asserted OAuth `guilds` list (which is a point-in-time snapshot
of *all* up to 200 of their guilds and reflects neither kicks nor role changes):
- A user may **view & control** a guild if the **bot verifies** they are a
  current member of it (bot's member cache, or `GET /guilds/{id}/members/{uid}`),
  re-validated per request (or short-TTL cached, ≤60 s).
- **Admins** (`ADMIN_USER_IDS`, strictly parsed snowflakes, fail-closed on a
  malformed value, never match on empty) may control **any** guild + perform
  **destructive** actions (clear queue, force-disconnect, move channel). Every
  destructive action is **audit-logged** (actor, guild, action, timestamp).
- The OAuth `guilds` list is at most a **UI hint** for the server selector,
  never the authorization decision. `GET /api/me` returns only the
  bot-verified intersection.
- **Griefing note:** in large servers, any member skipping/reordering shared
  playback is a vector. v1 accepts this; an optional `CONTROL_ROLE_IDS` / "skip
  only your own track unless admin" policy is a documented future toggle.

### 7.4 Abuse controls
Per-user and per-guild **rate limits** on all control endpoints (especially
`/play` and `/pick`, which spawn yt-dlp/ffmpeg and downloads), a **max queue
length**, **max concurrent/queued downloads per guild**, an input-size cap on
`{ input }`, a **global concurrency cap** on yt-dlp/ffmpeg subprocesses
(`MAX_TRANSCODE_JOBS`), and throttling on `/auth/login`+`/auth/callback`.
Resource-exhaustion by an authorized-but-malicious member is in scope.

## 8. Requester Attribution

```ts
type Requester = { discordUserId: string; displayName: string;
                   avatarUrl: string; source: 'discord' | 'web' };
type QueueItem  = { id: string; meta: TrackMeta; requester: Requester;
                    addedAt: number };
```
Every item has a **stable `id`** (used by remove/reorder, not array index) and
records its requester (Discord author / button clicker, or the logged-in web
user). The now-playing card and every queue row show the requester's name +
avatar; the bounded history shows who played what.

## 9. REST + WebSocket Contract

All routes namespaced by guild; control routes enforce `canControl` (§7.3) and
rate limits (§7.4).
- `GET  /api/me` → login + **bot-verified** guilds they may view (never the raw
  OAuth list).
- `GET  /api/guilds/:id/state` → `{ current, upcoming, history }`.
- `POST /api/guilds/:id/play` `{ input, voiceChannelId? }` → URL queued, or
  `{ candidates }` for a search needing a pick.
- `POST /api/guilds/:id/pick` `{ videoId, voiceChannelId? }`.
- `POST /api/guilds/:id/skip | pause | resume | stop`
- `POST /api/guilds/:id/queue/remove` `{ itemId }`
- `POST /api/guilds/:id/queue/reorder` `{ itemId, toIndex }`
- `GET  /auth/login`, `GET /auth/callback`, `POST /auth/logout`
- `GET  /healthz` → gateway-connected + server-up (for the compose healthcheck).
- **WebSocket** `/ws` — authenticated on upgrade via the session cookie **with an
  `Origin` allowlist check** (blocks cross-site WS hijacking). Client subscribes
  to guild topics it is authorized to view; each subscription is authorized via
  `canControl`/`canView`, and authorization is **re-validated** (on
  membership-change events) with the socket torn down (close 1008) if access is
  lost. Pushes `state` snapshots + incremental `changed`/progress events.

## 10. Frontend (React + Vite + Tailwind)

Full multi-server control panel; built by the `frontend-design` skill at
implementation time. Screens: **Login** ("Login with Discord") → **Server
selector** (bot-verified guilds) → **Now playing** (thumbnail, title, channel,
requester, live progress; pause/resume, skip, stop, voice-channel picker) →
**Queue** (rows keyed by item id, requester avatars; remove + drag-reorder) →
**Add** (paste link, or search → results → pick). One WebSocket multiplexing
guild topic subscriptions (not N sockets). Live updates throughout.

## 11. Errors, Lifecycle, Observability

- **Typed YouTube errors:** private / age-restricted / unavailable / not-a-video
  / live / over-long / `ENOSPC` / **SABR-or-PO-token "no playable audio"** /
  generic yt-dlp failure → friendly Discord + web messages; the bad item is not
  queued.
- **Resilience:** voice auto-reconnect; on fatal track error skip; auto-leave
  after `IDLE_TIMEOUT_SEC`; **top-level `unhandledRejection`/`uncaughtException`
  handlers** that log and keep the process alive; **`MAX_TRANSCODE_JOBS`** cap so
  prefetch can't fork-bomb the host; subprocess work never on the event loop.
- **Graceful shutdown (SIGTERM, every redeploy):** stop accepting new work,
  flush the active-session snapshot (§4.1), leave voice channels, kill child
  processes, exit within a grace window.
- **Startup canary:** resolve a known-good public video; log the resolved
  yt-dlp version and **fail loudly** if extraction is broken (the early signal
  for yt-dlp rot / IP block).
- **Logging:** structured logger (`pino`) with per-guild/per-request context and
  `LOG_LEVEL`; secrets never logged.

## 12. Testing Strategy (TDD)

Test-first for all pure logic:
- **URL parser** — every form in §3.1 (watch/`youtu.be`/shorts/embed/live/
  music./m./`&t=`/`&si=` stripping/`watch?v=&list=`), non-YouTube rejection.
- **queue (pure)** — add/remove/reorder/clear/skip/advance by **stable id**;
  **concurrent/interleaved** mutations through the mutex (no half-applied
  state; no double-advance); `needPrefetch` emitted (no I/O performed).
- **youtube service** — `resolve`/`search`/`download` with `yt-dlp` mocked
  (success + each typed-error path incl. SABR/PO-token + the `N/A`-field search
  case).
- **cache** — put/get, LRU eviction, **pinned still-queued items never evicted**.
- **auth/authz** — `canControl` truth table (member / non-member / kicked-stale /
  admin / destructive gating); **OAuth `state`** generation+verification
  (reject missing/forged/replayed); callback handler with a mocked Discord token
  endpoint (scope check, cookie attributes, tamper rejection, session rotation).
- **WS authorization** — allowed vs forbidden guild subscribe; Origin rejection.
- **voice-channel selection** — author-in-channel / not / bot-busy.
- **API handlers** — auth enforcement, rate limits, validation, error mapping.

Real audio playback, live DAVE negotiation, and the real OAuth round-trip are
verified by **manual integration** (real bot token + test server).

## 13. Configuration (environment variables)

Provided via `docker-compose` env (`.env`, not committed, perms `600`;
`.env.example` ships placeholders only). **R** = required, **O** =
optional/has-default.

| Var | R/O | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | R | Bot token (gateway + voice) — secret |
| `DISCORD_CLIENT_ID` | R | OAuth2 client id |
| `DISCORD_CLIENT_SECRET` | R | OAuth2 client secret — secret |
| `PUBLIC_BASE_URL` | R | Externally reachable base URL (browser-facing) |
| `OAUTH_REDIRECT_URI` | R | Must equal `PUBLIC_BASE_URL` + `/auth/callback`, https, and match the Discord portal registration |
| `SESSION_SECRET` | R | ≥32 random bytes; rotating it logs everyone out — secret |
| `ADMIN_USER_IDS` | O | Comma-separated admin snowflakes (strict parse, fail-closed) |
| `PORT` / `HOST` | O | Bind port / interface |
| `TRUST_PROXY` | O | Trust X-Forwarded-* (required behind the reverse proxy for secure cookies + correct redirect) |
| `NODE_ENV` | O | `production` enables Secure cookies / fail-fast checks |
| `LOG_LEVEL` | O | pino level |
| `CACHE_DIR` | O | Audio cache + session-snapshot path (= named-volume mount) |
| `CACHE_MAX_MB` | O | LRU cache size cap (≪ volume capacity) |
| `IDLE_TIMEOUT_SEC` | O | Auto-leave delay when queue empty |
| `HISTORY_MAX_ITEMS` | O | Per-guild history ring-buffer size |
| `SEARCH_RESULT_COUNT` | O | Search candidates (default 5) |
| `PREFETCH_DEPTH` | O | Tracks to pre-download (default 1; 0 disables) |
| `MAX_TRANSCODE_JOBS` | O | Global yt-dlp/ffmpeg concurrency cap |
| `MAX_TRACK_DURATION_SEC` | O | Reject over-long videos at resolve time |
| `SEARCH_RATE_LIMIT` / control rate limits | O | Per-user/per-guild throttles |
| `NORMALIZE_LOUDNESS` | O | EBU R128 pass (forces transcode path; default off) |
| `YT_PROXY` | O | Residential/ISP proxy for yt-dlp |
| `YT_COOKIES` | O | Path to a mounted cookies file |
| `PO_TOKEN_PROVIDER_URL` | O | bgutil PO-token sidecar URL |
| `YT_DLP_AUTO_UPDATE` | O | Self-update yt-dlp on start (fallback to baked pin) |

## 14. Deployment

### 14.1 Image (multi-stage)
- **Build stage:** build the React frontend + compile TypeScript.
- **Runtime stage:** pinned base (Node 22 LTS by tag+digest) + **ffmpeg** (apt;
  stable) + **`yt-dlp[default]` via pip** (EJS solver included) + **Deno** (nsig
  runtime) + the bundled crypto/opus libs. Run as a **non-root** user (`node`);
  `chown CACHE_DIR`. yt-dlp/ffmpeg/Deno live **only** in the runtime stage.
- **yt-dlp freshness (critical):** pin for reproducibility **but** decouple from
  code releases — a **scheduled (weekly) CI rebuild** re-pushes `:latest`,
  and/or `YT_DLP_AUTO_UPDATE` self-updates at start with fallback to the pin.
  Document the runbook (symptom: all downloads fail → pull latest / restart).

### 14.2 CI (GitHub Actions → GHCR, Atvriders)
- `permissions: { contents: read, packages: write }` (GITHUB_TOKEN is read-only
  for packages by default), login via `docker/login-action`.
- `on: { push: { branches: [master] }, workflow_dispatch: {}, schedule: [weekly] }`.
- **Fork first-build gotcha:** the first build must be kicked off manually via
  `workflow_dispatch` to create+link the GHCR package.
- **GHCR visibility:** a new package is **private by default** — after the first
  publish, set the package to **Public** (one-time manual step, or org default
  package visibility = public). Tag images `:latest` **and** the commit SHA
  (rollback).

### 14.3 Compose
- `image: ghcr.io/atvriders/discord-yt-music-bot:latest` (**pull**, no local
  `build:`); `env_file: .env`.
- Named volume mounted at exactly `CACHE_DIR` (audio cache + session snapshot).
- `restart: unless-stopped`; `healthcheck` hitting `/healthz`; `logging:
  json-file` with `max-size`/`max-file` rotation.
- Optional **bgutil PO-token sidecar** service (`:4416`) wired via
  `PO_TOKEN_PROVIDER_URL` when datacenter IP / PO-token enforcement bites.
- **Redirect/URL trap:** `PUBLIC_BASE_URL`/`OAUTH_REDIRECT_URI` must be the
  browser-reachable URL (scheme+host+port+path), matching the Discord portal —
  `localhost` only works for local dev. Fail fast if unset / localhost while
  `NODE_ENV=production`.

### 14.4 Prerequisites (README)
Create the Discord application; enable **Message Content** + **Guild Voice
States** intents; register the OAuth2 redirect URI; invite the bot with voice +
message permissions.

## 15. Key Risk & Decision (resolved)

The single biggest feasibility risk is **§5.1 YouTube datacenter-IP blocking**.
**Decision: host on a home/residential network**, which avoids the datacenter
penalty and gives ~85–95% extraction success with **no proxy required**. The
bot therefore defaults to **direct YouTube access**; cookies, residential proxy,
and the PO-token sidecar remain implemented and config-toggled as fallbacks
(`YT_PROXY`/`YT_COOKIES`/`PO_TOKEN_PROVIDER_URL`) for the case where even the
home IP gets flagged. (Self-hosting also fits the personal/private-server
framing of the §2 ToS caveat.)

## 16. Resolved Decisions

- Song names → search + explicit user pick (never auto-substitute). ✔
- Deployment → GitHub Actions → GHCR (public), compose pulls image, env config,
  hardened per §14. ✔
- Frontend → full control panel, React + Vite + Tailwind. ✔
- Multi-server, per-guild isolation + bot-verified authz. ✔
- Web auth → Discord OAuth2 (with `state`), server-side sessions; control =
  bot-verified members + admin allowlist. ✔
- Requester attribution for all requests (Discord + web). ✔
- Audio → Opus passthrough preferred, transcode fallback; DAVE + AEAD. ✔
