# discord-yt-music-bot — Design Spec

- **Date:** 2026-06-25
- **Status:** Approved design, pending implementation plan
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

## 2. Goals / Non-Goals

### Goals
- Play audio from a **specific** YouTube video, chosen by the requester. Direct
  URLs always play that exact video.
- Highest practical audio quality (best available source audio, encoded at the
  maximum bitrate Discord's voice gateway permits).
- `?`-prefixed Discord commands to queue links/searches and control playback.
- Web control panel: live now-playing + queue, full playback control, add by
  link or search, **requester attribution**.
- Discord OAuth2 login for the panel; control gated by server membership /
  admin allowlist.
- Multi-server: one bot instance serves many Discord servers, each with an
  independent voice session and queue.
- One-container deployment; image built by GitHub Actions to GHCR; configured
  entirely via environment variables in `docker-compose`.

### Non-Goals (YAGNI)
- No "find me a song like X" / auto-substitution of an equivalent video.
- No support for non-YouTube sources (Spotify, SoundCloud, direct files).
- No persistent database in v1 — queue/session state is in-memory (lost on
  restart). A play **history** is kept in memory and exposed read-only; durable
  history is a future enhancement.
- No playlist import in v1 (single video per request). Possible follow-up.
- No horizontal scaling / multi-instance sharding — single process.

## 3. The Exact-Link Rule (core behavior)

| Input type | Behavior |
|---|---|
| A `youtube.com` / `youtu.be` video URL | Validate it resolves to a real, playable video, then queue **that exact video**. Never substituted. |
| A non-URL text query (song name) | Run a YouTube search, present the top ~5 results (title, channel, duration) as button choices. **Only the video the requester picks is queued.** No automatic pick. |
| A non-YouTube URL | Rejected with a friendly "YouTube links only" message. |

The search path is the *only* place a name maps to a video, and it always
requires an explicit human choice. The bot never auto-selects.

## 4. Architecture

Single TypeScript/Node 20 process containing the Discord bot, the HTTP/WebSocket
API, and the static frontend. One process means the queue manager is the single
source of truth shared by Discord and web with no cross-process sync.

```
                ┌──────────────────────── Node process ───────────────────────┐
 Discord  ◄────►│  discord/      youtube/        voice/        queue/          │
 gateway        │  (? commands,  (yt-dlp wrap:   (per-guild    (per-guild      │
                │   buttons)      resolve/        connection    state: current │
                │      │          search/         + AudioPlayer)+ upcoming)     │
                │      └──────────download)──────────┬───────────────┘         │
                │                                     │ events                  │
                │   server/ (fastify REST + ws)  ◄────┘                         │
                │      │  auth/ (Discord OAuth2, sessions, authz)               │
                │      └── serves web/ (built React app) ──────────────────────│
                └──────────────────────────────┬──────────────────────────────┘
                                                │ REST + WebSocket
                                          Browser (React panel)
```

### Components (each isolated, single-purpose, testable)

- **`youtube/`** — wraps the `yt-dlp` binary as a subprocess.
  - `resolve(url): Promise<TrackMeta>` — validate a URL is a real playable
    video; return `{ videoId, title, channel, durationSec, thumbnailUrl }`.
    Rejects private/age-restricted/unavailable/non-video URLs with typed errors.
  - `search(query, limit=5): Promise<TrackMeta[]>` — `ytsearch{limit}:query`,
    return candidate metadata (no download).
  - `download(videoId): Promise<string>` — fetch best audio to the cache, return
    the local file path. Idempotent (returns cached path if present).
  - Pure interface over a subprocess → unit-tested with the subprocess mocked.

- **`cache/`** — on-disk audio cache keyed by `videoId`, LRU-evicted by total
  size (`CACHE_MAX_MB`). `get(videoId)`, `put(videoId, file)`, eviction.

- **`voice/`** — per-guild voice session.
  - Join/leave a voice channel, hold a `@discordjs/voice` `AudioPlayer`.
  - `play(file)`, `pause()`, `resume()`, `skip()`, `stop()`.
  - Emits `trackStart`, `trackEnd`, `idle`, `error`.
  - Auto-reconnect on transient disconnect; auto-leave after `IDLE_TIMEOUT_SEC`
    of an empty queue.

- **`queue/`** — per-guild queue state and the single source of truth for "now
  playing." `current`, `upcoming[]`, `history[]`. Operations: `add(item)`,
  `remove(index)`, `reorder(from,to)`, `clear()`, `skip()`, `advance()` (called
  on `trackEnd`). Each `QueueItem` carries its requester. Emits a `changed`
  event that the server broadcasts. Prefetches/downloads the next track while
  the current one plays.

- **`discord/`** — Discord gateway client + `?` command parser + button-based
  search picker. Translates chat into queue/voice operations; renders now-playing
  and search-result messages.

- **`auth/`** — Discord OAuth2 login (`identify` + `guilds`), signed session
  cookie, and the authorization predicate (`canControl(user, guildId)`).

- **`server/`** — fastify REST endpoints + `ws` broadcaster, all keyed by
  `guildId`; serves the built frontend as static assets.

- **`web/`** — React + Vite + Tailwind control panel.

## 5. Audio Pipeline & "Highest Quality"

1. `yt-dlp -f bestaudio` selects the best audio-only stream for the chosen
   `videoId` and downloads it to the cache (download-to-cache, not live-stream).
2. `ffmpeg` transcodes the cached file to 48 kHz stereo Opus.
3. `@discordjs/voice` plays the resource into the voice channel at the channel's
   maximum permitted bitrate.

**Why download-to-cache (not stream-on-the-fly):** robust against mid-track
network blips, enables instant replay and de-duplication of repeated requests,
and lets us prefetch the next track during playback. Trade-off: a short
buffering delay before a brand-new (uncached) track starts, plus disk usage
(bounded by the LRU cache).

**Honest quality caveat:** Discord's voice gateway caps Opus bitrate (≈96 kbps
by default; higher — up to ~256–384 kbps — only in boosted servers). "Highest
quality" therefore means *best available source audio encoded at the maximum
bitrate the target voice channel allows* — it cannot exceed Discord's ceiling.
The encoder reads the channel's bitrate and uses it.

## 6. Discord Command Interface (`?` prefix)

Requires the **Message Content** privileged intent (enabled in the Discord
Developer Portal) because commands are read from message content.

| Command | Action |
|---|---|
| `?play <url\|query>` / `?<url\|query>` | URL → queue exact video; query → search + button picker |
| `?skip` | Skip current track |
| `?pause` / `?resume` | Pause / resume |
| `?stop` | Stop and clear the queue |
| `?queue` | Show the queue with requesters |
| `?np` | Now playing (title, requester, progress) |
| `?remove <n>` | Remove queue item `n` |
| `?help` | Command list |

Search results are presented as **button components** (not emoji reactions);
clicking a button queues that specific video, attributed to the clicker.

## 7. Authentication & Authorization (web)

- **Login:** Discord OAuth2, scopes `identify` + `guilds`. On callback the
  backend exchanges the code, stores `{ id, username, avatar, guilds }` in a
  signed session cookie (`SESSION_SECRET`). Redirect URI must be registered in
  the Discord Developer Portal and provided as `OAUTH_REDIRECT_URI`.
- **Authorization — `canControl(user, guildId)`:**
  - A user may **view and control** a server's playback if they are a **member**
    of that server (intersection of the bot's guilds and the user's `guilds`).
  - **Admins** (`ADMIN_USER_IDS`, comma-separated Discord user IDs) may control
    **any** server the bot is in, and are the only ones allowed **destructive**
    actions (clear queue, force-disconnect).
  - Non-members see neither the server nor its queue (unless admin).
- All control REST endpoints enforce `canControl`; the WebSocket only streams a
  guild's state to sessions allowed to view it.

## 8. Requester Attribution

Every `QueueItem` records its requester regardless of origin:

```ts
type Requester = { discordUserId: string; displayName: string;
                   avatarUrl: string; source: 'discord' | 'web' };
type QueueItem = { meta: TrackMeta; requester: Requester; addedAt: number };
```

- Discord `?` requests → requester is the message author / button clicker.
- Web requests → requester is the logged-in Discord user.
- The now-playing card and every queue row show the requester's name + avatar;
  the history view shows who played what.

## 9. REST + WebSocket Contract (sketch)

All routes namespaced by guild. Auth via session cookie; control routes enforce
`canControl`.

- `GET  /api/me` → current login + the guilds they may view.
- `GET  /api/guilds/:id/state` → `{ current, upcoming, history }`.
- `POST /api/guilds/:id/play` `{ input }` → URL queued, or `{ candidates }` for
  a search needing a pick.
- `POST /api/guilds/:id/pick` `{ videoId }` → queue a chosen search result.
- `POST /api/guilds/:id/skip | pause | resume | stop`
- `POST /api/guilds/:id/queue/remove` `{ index }`
- `POST /api/guilds/:id/queue/reorder` `{ from, to }`
- `GET  /auth/login`, `GET /auth/callback`, `POST /auth/logout`
- **WebSocket** `/ws?guild=:id` → pushes `state` snapshots and incremental
  `changed` events (now-playing, progress ticks, queue mutations).

## 10. Frontend (React + Vite + Tailwind)

Full multi-server control panel; built by the `frontend-design` skill at
implementation time. Screens:
- **Login** — "Login with Discord".
- **Server selector** — the servers the logged-in user may view.
- **Now playing** — thumbnail, title, channel, requester, live progress bar;
  pause/resume, skip, stop.
- **Queue** — ordered rows with requester avatars; remove and drag-reorder.
- **Add** — paste a YouTube link, or type a query → results list → pick one.
- Live updates via WebSocket.

## 11. Error Handling & Lifecycle

- Typed YouTube errors (private / age-restricted / unavailable / not-a-video /
  yt-dlp failure) → friendly Discord and web messages; the bad item is not
  queued.
- Voice: auto-reconnect on transient disconnect; on fatal error skip the track;
  auto-leave after `IDLE_TIMEOUT_SEC` with an empty queue.
- Empty queue / stop → clear current, broadcast state.
- Subprocess failures are captured (stderr surfaced in logs), never crash the
  process.

## 12. Testing Strategy (TDD)

Test-first for all pure logic:
- **link/name parser** — URL vs query classification, `youtu.be`/`watch?v=`/
  `shorts` URL forms, non-YouTube rejection.
- **queue manager** — add/remove/reorder/clear/skip/advance, requester carried,
  prefetch trigger, events emitted.
- **youtube service** — `resolve`/`search`/`download` with the `yt-dlp`
  subprocess mocked (success + each typed-error path).
- **cache** — put/get, LRU eviction at the size cap.
- **auth/authz** — `canControl` truth table (member, non-member, admin,
  destructive-action gating).
- **API handlers** — auth enforcement, request validation, error mapping.

Voice playback and live Discord/OAuth flows are verified by **manual
integration** (real bot token + test server), not unit tests.

## 13. Configuration (environment variables)

Provided via `docker-compose` env (`.env`, not committed; `.env.example`
shipped):

| Var | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token (gateway + voice) |
| `DISCORD_CLIENT_ID` | OAuth2 client id |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `OAUTH_REDIRECT_URI` | Registered OAuth2 callback URL |
| `SESSION_SECRET` | Session-cookie signing secret |
| `ADMIN_USER_IDS` | Comma-separated admin Discord user IDs |
| `PORT` | HTTP/WebSocket port (frontend + API) |
| `IDLE_TIMEOUT_SEC` | Auto-leave delay when queue empty |
| `CACHE_MAX_MB` | Audio cache size cap (LRU) |
| `SEARCH_RESULT_COUNT` | Search candidates to present (default 5) |

## 14. Deployment

- **Image:** multi-stage Docker — build the frontend and compile TypeScript,
  then a runtime stage with Node 20 + `ffmpeg` + `yt-dlp` (pinned).
- **CI:** GitHub Actions builds and pushes `ghcr.io/atvriders/
  discord-yt-music-bot:latest` (public) on push (Atvriders workflow).
- **Compose:** `docker-compose.yml` **pulls** the GHCR image (`image:`, no local
  `build:`), reads config from `.env`, mounts a named volume for the audio
  cache, exposes `PORT`.
- **Prerequisites (documented in README):** create the Discord application,
  enable the Message Content privileged intent, add OAuth2 redirect URI, invite
  the bot with voice + message permissions.

## 15. Resolved Decisions (no open questions)

- Song names → search + explicit user pick (never auto-substitute). ✔
- Deployment → GitHub Actions → GHCR, compose pulls image, env config. ✔
- Frontend → full control panel, React + Vite + Tailwind. ✔
- Multi-server. ✔
- Web auth → Discord OAuth2; control = server members + admin allowlist. ✔
- Requester attribution for all requests (Discord + web). ✔
