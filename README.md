<p align="center"><img src="assets/logo.png" width="660" alt="YouTube Music Bot — the real audio from the exact video, never a mirror track"></p>

# discord-yt-music-bot

A Discord bot that plays YouTube audio in voice channels — the **real audio from the exact video you give it**, never a re-uploaded or "mirror" audio track. It supports direct-URL playback, search-and-pick via button menus, per-guild queues with prefetch, a real-time web control panel with Discord login, and configurable admin controls.

---

## How It Works

**Exact-link, never a mirror.** Give it a YouTube URL and it plays _that_ video's audio. Give it search terms and it shows a button picker so **you** choose the exact result — it never silently substitutes a re-upload or a separate "audio" track.

**The video's own audio — no ads.** It extracts the chosen video's audio stream with `yt-dlp` (trying several player clients for reliability on datacenter IPs) and downloads it to a local cache, then streams that file into Discord voice. Because it pulls the content stream directly, there are no video ads and no SSAI mid-rolls. Optional **SponsorBlock** segment removal is supported.

**Highest-quality audio path.** When the source stream is already Opus, it is passed through to Discord **without re-encoding** (best possible quality); otherwise `ffmpeg` transcodes to Opus. Voice traffic is end-to-end encrypted (Discord's DAVE protocol) automatically.

**Per-guild orchestration.** Each server has its own queue and a mutex-guarded playback controller. Upcoming tracks are pre-downloaded (`PREFETCH_DEPTH`) so playback is gapless, and the bot auto-leaves after `IDLE_TIMEOUT_SEC` of inactivity. An active-session snapshot is written to the cache, so after a restart the bot **rejoins and resumes** automatically.

**One brain, two front-ends.** A Fastify server hosts a React control panel, a REST API, and a per-guild WebSocket. You log in with Discord OAuth2; the bot then verifies (via the gateway) that you are actually a **member** (or an admin) of a guild before letting you control it. The web panel and Discord commands share the **same** controller — anything you do on the panel affects the same playback as `?` commands, and the panel mirrors state live over the WebSocket (now-playing with a moving progress bar, the queue, and controls).

---

## Discord Application Setup

### 1. Create a Discord Application

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Give it a name (e.g. `yt-music-bot`) and click **Create**.
3. Select **Bot** in the left sidebar.
4. Click **Reset Token** and copy the **Token** — this is your `DISCORD_TOKEN`.

### 2. Enable Privileged Intents

Still on the **Bot** page, under **Privileged Gateway Intents**, enable **both**:

- **Message Content Intent** — required to read `?` command text.
- **Server Members Intent** — required so the **web panel** can verify that a logged-in user is a member of the server before allowing control. Without it, panel controls (play/pause/skip) may be rejected with `forbidden`.

Save changes.

### 3. Invite the Bot to Your Server (OAuth2)

1. Go to **OAuth2 → URL Generator**.
2. Under **Scopes**, check `bot`.
3. Under **Bot Permissions**, check: **View Channels, Send Messages, Connect, Speak, Use Voice Activity**.
4. Open the generated URL and select the server to invite the bot.

> The bot must have **Connect** _and_ **Speak** in the specific voice channel. If a channel permission override denies **Speak**, the bot will join but produce no audio.

---

## Configuration

All configuration lives in the `environment:` block of `docker-compose.yml` — there is **no `.env` file**. Replace the `CHANGE_ME` placeholders with your real values. Do **not** commit a `docker-compose.yml` containing real secrets; keep your filled-in copy local.

### Bot

| Variable                 | Required | Default                      | Description                                                                                                                               |
| ------------------------ | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`          | yes      | —                            | Bot token from the Developer Portal                                                                                                       |
| `COMMAND_PREFIX`         | no       | `?`                          | Command prefix (e.g. `?play`, `?skip`)                                                                                                    |
| `CACHE_DIR`              | no       | `/data/cache`                | Directory for downloaded audio + the session snapshot                                                                                     |
| `CACHE_MAX_MB`           | no       | `2048`                       | Max cache size (MB); least-recently-used files are evicted above this                                                                     |
| `IDLE_TIMEOUT_SEC`       | no       | `300`                        | **Initial default** seconds of silence before the bot leaves the voice channel — the web panel can override this **per guild at runtime** |
| `PREFETCH_DEPTH`         | no       | `1`                          | Upcoming tracks to pre-download (higher = smoother, more memory)                                                                          |
| `MAX_TRANSCODE_JOBS`     | no       | `2`                          | Max concurrent yt-dlp downloads (higher = more CPU/memory)                                                                                |
| `MAX_TRACK_DURATION_SEC` | no       | —                            | Reject tracks longer than this; unset = no limit                                                                                          |
| `SEARCH_RESULT_COUNT`    | no       | `5`                          | Number of search results in the picker (max 5)                                                                                            |
| `ADMIN_USER_IDS`         | no       | —                            | Comma-separated Discord user IDs with admin privileges (control any channel)                                                              |
| `LOG_LEVEL`              | no       | `info`                       | pino log level (`debug`, `info`, `warn`, `error`)                                                                                         |
| `YT_PLAYER_CLIENTS`      | no       | `android_vr,web_embedded,tv` | yt-dlp player clients to try (see note below)                                                                                             |
| `YT_PROXY`               | no       | —                            | Residential/SOCKS proxy for yt-dlp, if your IP is blocked by YouTube                                                                      |
| `YT_COOKIES`             | no       | —                            | Path to a mounted Netscape `cookies.txt` (helps on flagged IPs)                                                                           |
| `PO_TOKEN_PROVIDER_URL`  | no       | —                            | PO-token provider URL; only set when running the `pot` sidecar                                                                            |
| `SPONSORBLOCK_REMOVE`    | no       | —                            | SponsorBlock categories to skip (e.g. `sponsor,intro,outro,selfpromo`)                                                                    |

### Web panel (also required for the panel)

| Variable                | Required | Default                           | Description                                                               |
| ----------------------- | -------- | --------------------------------- | ------------------------------------------------------------------------- |
| `DISCORD_CLIENT_ID`     | yes      | —                                 | OAuth2 application Client ID                                              |
| `DISCORD_CLIENT_SECRET` | yes      | —                                 | OAuth2 application Client Secret                                          |
| `PUBLIC_BASE_URL`       | yes      | —                                 | Public HTTPS origin (e.g. `https://music.example.com`); no trailing slash |
| `OAUTH_REDIRECT_URI`    | no       | `<PUBLIC_BASE_URL>/auth/callback` | Must exactly match a Discord OAuth2 redirect URI                          |
| `SESSION_SECRET`        | yes      | —                                 | Random string ≥ 32 chars used to sign session cookies (NOT your token)    |
| `PORT`                  | no       | `8080`                            | Port the HTTP server listens on                                           |
| `HOST`                  | no       | `0.0.0.0`                         | Interface to bind                                                         |
| `TRUST_PROXY`           | no       | `true`                            | Set `false` only if **not** behind a reverse proxy                        |
| `ALLOWED_WS_ORIGINS`    | no       | `<PUBLIC_BASE_URL>`               | Comma-separated origins allowed to open the live WebSocket                |

> Generate `SESSION_SECRET` with `openssl rand -base64 32`. Never reuse your bot token for it.

---

## Running

### Local development (`tsx` hot-reload)

```bash
npm install
DISCORD_TOKEN=your-token npm run dev      # bot  (:8080)
npm run dev:web                           # panel (:5173, proxies /api /auth /ws → :8080)
```

### Production build

```bash
npm run build                             # build:web (Vite → dist/public) + tsc (→ dist)
DISCORD_TOKEN=your-token node dist/index.js
```

### Docker & deploy

The deploy flow needs no local build and no `.env`:

1. **GitHub Actions** builds the image and pushes `ghcr.io/atvriders/discord-yt-music-bot:latest` (and a `:<sha>` tag) on every push to `master`, plus a weekly rebuild to keep `yt-dlp` fresh.
2. **You** fill in the `environment:` block of `docker-compose.yml`.
3. **`docker compose up -d`** pulls the pre-built image and runs it.

```bash
docker compose up -d
```

#### First-time setup

1. **GHCR visibility** — after the first build, set the [package](https://github.com/Atvriders/discord-yt-music-bot/pkgs/container/discord-yt-music-bot) to **Public** so pulls need no auth.
2. **Forked repo** — the first Actions build needs a manual trigger: **Actions → build → Run workflow**.

#### Updating to a new build (important)

A plain `docker compose up -d` may keep your **local** cached image even when a newer `:latest` exists. Force a real re-pull + recreate:

```bash
docker compose pull bot && docker compose up -d --force-recreate bot
```

In **Portainer**, enable **"Re-pull image"** when redeploying the stack — otherwise it reuses the old image. To confirm what's actually running:

```bash
docker inspect "$(docker compose ps -q bot)" --format 'image: {{.Image}}'
docker image inspect ghcr.io/atvriders/discord-yt-music-bot:latest --format 'latest: {{.Id}}'
# the two SHAs should match
```

#### PO-token sidecar (optional)

Only needed if you switch `YT_PLAYER_CLIENTS` to `web,mweb`:

```bash
docker compose --profile pot up -d
```

and set `PO_TOKEN_PROVIDER_URL=http://bgutil-pot:4416`. With the default zero-PO-token clients you do **not** need this.

---

## Deployment Notes & Gotchas

These are the things that most commonly break a self-host:

- **The cache volume must be writable by the container's non-root user.** The container starts as root only long enough to `chown` `/data/cache` (via a `gosu` entrypoint), then drops to an unprivileged user — so a named volume _or_ a bind-mounted host directory works automatically. If you previously had a root-owned volume causing `EACCES` (silent no-audio + snapshot crash-loop), pulling the current image fixes it.
- **`ALLOWED_WS_ORIGINS` must equal `PUBLIC_BASE_URL` exactly.** The live "now playing" box, progress bar, and queue are driven entirely by a WebSocket; if the browser's `Origin` isn't allowlisted, the upgrade is rejected (`403 bad_origin`) and the panel never updates — even though Discord audio plays fine.
- **`YT_PLAYER_CLIENTS` should stay on the zero-PO-token defaults** (`android_vr,web_embedded,tv`). Using `web`/`mweb` requires the PO-token sidecar above, or extraction silently fails (resolves metadata but downloads nothing → no audio).
- **Your proxy/CDN must forward WebSocket upgrades** (see the nginx snippet below). Behind **Cloudflare**, ensure zone **Network → WebSockets** is **On** (default). With a **Cloudflare Tunnel**, WebSockets are forwarded automatically — just avoid forcing an HTTP/2 origin connection, which breaks the `Upgrade`.
- **Voice "Speak" permission** — if the bot is in the channel but silent with no error, check it has **Connect + Speak** there.
- **Memory** — `node` + `yt-dlp` + `ffmpeg` per `PREFETCH_DEPTH`/`MAX_TRANSCODE_JOBS` can be heavy on a small VPS. If the container is OOM-killed mid-song (it restarts and resumes), lower `PREFETCH_DEPTH`/`MAX_TRANSCODE_JOBS` and/or set a `mem_limit`.

### Reverse proxy (nginx)

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Required for WebSocket upgrades:
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Keep `TRUST_PROXY=true` so rate limiting reads the real client IP from `X-Forwarded-For`.

### OAuth2 redirect URI

In the [Developer Portal](https://discord.com/developers/applications) → your app → **OAuth2 → Redirects**, add the **exact** URI (Discord rejects even a trailing-slash mismatch):

```
<PUBLIC_BASE_URL>/auth/callback
```

---

## Web Control Panel

A browser interface for queuing, viewing now-playing, managing the queue, and controlling playback across all the servers you share with the bot. It uses a YouTube-style dark theme.

What it does:

- **Discord login** — OAuth2; only servers you actually belong to appear, and control is gated on membership/admin.
- **Remembers your last server** — defaults back to the server you last used.
- **Auto-selects your voice channel** — if you're already in a voice channel, the picker defaults to it (your manual choice still wins).
- **Live now-playing with a moving progress bar** — elapsed/duration ticks in real time and freezes when paused; updates instantly on play/skip/pause from either the panel or Discord. (Display-only — there is no click-to-seek.)
- **Instant submit** — paste a link and press Enter; the box clears and shows "Resolving…" immediately while extraction runs in the background, then "Queued: …".
- **Queue management** — see pending tracks + requesters, remove (✕), and reorder (▲/▼), all reflected live.
- **Idle-timeout setting** — choose how long the bot stays in the voice channel after playback ends (1/5/10/15/30 minutes, or "Never"), per server, from a dropdown. Defaults to 5 minutes and overrides `IDLE_TIMEOUT_SEC` at runtime; changes apply immediately (a running idle timer restarts).

### Manual verification (web panel)

Requires a real Discord app, a valid `SESSION_SECRET`, and a TLS reverse proxy.

- [ ] `/healthz` returns `{"ok":true}` (HTTP 200)
- [ ] `GET /auth/login` → 302 to `discord.com/oauth2/authorize`, sets the `sid` cookie; after consent you land on `/` and `GET /api/me` returns your `id`/`username`/`avatarUrl`
- [ ] The server selector lists only servers you belong to and defaults to your last-used one
- [ ] With the bot playing, **Now Playing** updates live and the progress bar advances; pausing freezes it
- [ ] Paste a URL → box clears + "Resolving…" → "Queued: …"; a search query opens the picker
- [ ] The voice-channel picker defaults to the channel you're in; **Queue** shows tracks + requesters; ✕ removes; ▲/▼ reorder — all live
- [ ] The **Leave channel after tracks end** dropdown reflects the current per-guild setting (default 5 min); changing it persists for that guild and takes effect immediately; `GET /api/guilds/:id/settings` returns `{ "idleTimeoutSec": … }` and `POST` with `{ "idleTimeoutSec": 0..3600 }` applies it (out-of-range → `400`)
- [ ] A server you can't control shows **No access** with controls disabled
- [ ] `POST /api/guilds/:id/skip` with a valid session returns `{"ok":true}`; without a session, `401`; `GET /api/guilds/:id/state` returns `403` for a guild you're not in
- [ ] `POST /auth/logout` destroys the session; `GET /api/me` then returns `401`

---

## Command Reference

All commands use the configured prefix (default `?`).

| Command                | Description                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `?play <youtube-url>`  | Queue a video directly by URL                                                                             |
| `?play <search terms>` | Search YouTube and show a button picker                                                                   |
| `?<search terms>`      | Shorthand for `?play <search terms>`                                                                      |
| `?skip`                | Skip the currently playing track                                                                          |
| `?pause`               | Pause playback (bot stays in the channel)                                                                 |
| `?resume`              | Resume playback                                                                                           |
| `?stop`                | Stop playback and clear the queue; **the bot stays in the channel** (it leaves later on the idle timeout) |
| `?queue`               | Show the current queue                                                                                    |
| `?np`                  | Show the now-playing track                                                                                |
| `?remove <n>`          | Remove queue item number `n`                                                                              |
| `?help`                | Show command help                                                                                         |

---

## Manual Verification (Discord)

Requires a real bot token and a server.

### Gateway / voice

- [ ] Bot logs `discord-yt-music-bot is online` and appears online in Discord
- [ ] Join a voice channel, `?play https://www.youtube.com/watch?v=<id>` → bot joins and plays within ~10s

### Playback controls

- [ ] `?skip` advances (or goes idle if the queue is empty)
- [ ] `?pause` pauses; bot stays in channel — `?resume` resumes
- [ ] `?stop` stops playback and clears the queue; the bot **stays in the channel** and leaves later once `IDLE_TIMEOUT_SEC` elapses with nothing playing

### Search / queue

- [ ] `?play lofi hip hop` → numbered list with buttons 1–5; clicking **2** queues exactly the second result, attributed to the clicker
- [ ] `?queue` lists pending tracks; `?np` shows the current track + requester; `?remove 1` removes the first upcoming track

### Idle auto-leave & admin

- [ ] After the queue ends and `IDLE_TIMEOUT_SEC` passes with no new tracks, the bot leaves
- [ ] A user in `ADMIN_USER_IDS` can queue/control from any channel; non-admins must be in the bot's channel

### Error handling

- [ ] An invalid, private, age-restricted, or deleted video returns a friendly `❌` message, not a crash
