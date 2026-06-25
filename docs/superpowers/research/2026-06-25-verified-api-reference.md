# Verified API Reference & Canonical Decisions (mid-2026)

Distilled from four parallel research agents (yt-dlp, discord.js voice, Fastify/OAuth/WS,
scaffold/Docker/CI), each web-verified against current docs/source. This is the
companion reference for the implementation plans. **Where agents disagreed, the
canonical choice is recorded here and overrides the individual notes.**

## 0. Canonical versions & reconciliations (authoritative)

| Concern | Canonical choice | Why |
|---|---|---|
| Node floor | **Node 22.12+** (image `node:22.23-bookworm` build / `-slim` runtime) | `@discordjs/voice` 0.19.x requires Node ≥22.12; Fastify v5 only needs ≥20, so 22.12 satisfies both. |
| `@discordjs/voice` | **^0.19.2** (NOT 0.18) | DAVE E2EE enforced Discord-wide **2026-03-01**; <0.19.1 can't join voice. 0.19.2 fixes packet padding. The 0.19.x DAVE bug is **receive-only** — playback/sending is fine. |
| Voice encryption lib | **@noble/ciphers** (pure JS) | No native build → slim Docker. `@discordjs/voice` auto-negotiates `aead_aes256_gcm_rtpsize` (native `node:crypto`, preferred) / `aead_xchacha20_poly1305_rtpsize`. Legacy xsalsa20 removed 2024-11-18. |
| Opus encoder | **@discordjs/opus** (^0.10) | Only used on the transcode-fallback path (PCM→Opus). Native, has prebuilds. |
| DAVE | Automatic via bundled `@snazzah/davey` (≥0.19.1) | No manual wiring. |
| yt-dlp install | **`pip install "yt-dlp[default]"`** (NOT standalone binary) | `[default]` extra bundles `yt-dlp-ejs` (the nsig EJS solver scripts) in-image. |
| JS runtime for nsig | **Deno** binary on PATH (Node ≥22 is fallback) | yt-dlp's EJS solver needs an external JS runtime; Deno is default/sandboxed. |
| Session plugin | **@fastify/session** (server-side store) NOT @fastify/secure-session | We want an opaque cookie + revocable server-side record, not a client-side blob. |
| WS | **@fastify/websocket** (wraps `ws`) | Session cookie pre-parsed before the upgrade hook. |
| Test runner | **vitest** + **tsx** (dev) + **tsc** (typecheck/build) | Easy `node:child_process` mocking for the yt-dlp wrapper. |

> The scaffold agent's `package.json` listed `@discordjs/voice@^0.18.0` + `sodium-native`
> + Fastify-only Node ≥20 — **superseded** by the row values above.

---

## 1. yt-dlp subprocess interface

**Env:** requires `pip install "yt-dlp[default]"` + a JS runtime (Deno) on PATH for nsig.

**resolve(url)** — one video, no download:
```
yt-dlp -J --no-playlist --no-warnings --no-progress -- <url>
```
`-J` → exactly one JSON info-dict. Fields: `id, title, channel` (fallback `uploader`),
`duration` (sec, null for live), `is_live`/`live_status`, `thumbnail`, `availability`.
`--no-playlist` makes `watch?v=ID&list=...` resolve only the video. Always pass `--`.

**search(query, N)** — flat, no download:
```
yt-dlp -J --flat-playlist --no-warnings --no-progress -- "ytsearchN:<query>"
```
Result objects in `.entries[]`: `id, title, url, duration?, channel?`. With
`--flat-playlist`, `channel`/`duration` may be **null** → picker tolerates missing
fields; do a full `resolve()` only on the chosen `id`.

**download(videoId)** — best audio to file, Opus passthrough preserved:
```
yt-dlp -f 'bestaudio[acodec=opus]/bestaudio/best' --no-playlist \
  --max-filesize 100M --socket-timeout 30 --retries 3 --no-warnings --no-progress \
  -o '<CACHE_DIR>/%(id)s.%(ext)s' -- 'https://www.youtube.com/watch?v=<id>'
```
No `-x/--audio-format` ⇒ no re-encode (lossless Opus passthrough when source is Opus).
**No total-time flag exists** — enforce wall-clock via the kill-timer in §7-node.

**SponsorBlock** (opt-in; forces re-encode, breaks passthrough):
```
yt-dlp -x --audio-format opus --sponsorblock-remove sponsor,music_offtopic ...
```
Categories: `sponsor, intro, outro, selfpromo, preview, filler, interaction,
music_offtopic, poi_highlight*, chapter*` (`*`=mark-only), plus `all`, `default`.

**2026 reliability flags:**
- `--extractor-args "youtube:player_client=android_vr,web_embedded,tv"` → zero-PO-token
  path (android_vr fails only on "made for kids"; web_embedded only embeddable).
- `--cookies <netscape-file>` (private/age-restricted/IP-block), `--proxy <url>`
  (residential to beat datacenter blocks).
- bgutil POT provider: sidecar `brainicism/bgutil-ytdlp-pot-provider:4416` +
  `pip install bgutil-ytdlp-pot-provider`; auto-discovered, or
  `--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"`, target `mweb`.

**Typed-error stderr matches** (case-insensitive substrings; classify in priority order
botblock→private→membersonly→agerestricted→geoblocked→unavailable→potoken/sabr→ratelimited→unknown):
- private: `Private video` / `This video is private`
- age: `Sign in to confirm your age` / `age-restricted`
- unavailable: `Video unavailable` / `has been removed` / `no longer available`
- members: `members-only` / `available to this channel's members`
- geo: `not made this video available in your country`
- live: prefer `live_status`/`is_live` from `-J`; `This live event will begin in`
- **IP block:** `Sign in to confirm you're not a bot` / `Your IP is likely being blocked`
- **SABR/PO-token:** `Only images are available` / `require a GVS PO Token` / `nsig extraction failed`
- rate-limit: `rate-limited by YouTube`

**Node invocation:** `child_process.spawn("yt-dlp", argsArray, {stdio:["ignore","pipe","pipe"]})`,
buffer stdout (JSON) + stderr (classify), `setTimeout(()=>child.kill("SIGKILL"), timeoutMs)`,
resolve on `close`, reject on `error` (ENOENT). Never `shell:true`; never interpolate URL.

---

## 2. discord.js v14 + @discordjs/voice ≥0.19.2

**Intents:** `Guilds`, `GuildVoiceStates` (required for `member.voice`), `GuildMessages`,
`MessageContent` (privileged), `GuildMembers` (for bot-verified `members.fetch`, + portal
Server Members Intent). Author's channel: `message.member?.voice.channel`.

**Join:** `joinVoiceChannel({channelId, guildId, adapterCreator: guild.voiceAdapterCreator})`
then `await entersState(conn, VoiceConnectionStatus.Ready, 30_000)`. On
`VoiceConnectionStatus.Disconnected`: race `entersState(Signalling/Connecting, 5_000)`
else `connection.destroy()`. Guard destroy if already `Destroyed`.

**Player + passthrough resource (preferred):**
```ts
const player = createAudioPlayer({ behaviors:{ noSubscriber: NoSubscriberBehavior.Pause }});
connection.subscribe(player);
const resource = createAudioResource(createReadStream(file), {
  inputType: StreamType.WebmOpus,   // or OggOpus — prism-media demuxer (bundled), NO ffmpeg
  inlineVolume: false,              // true defeats passthrough
  metadata: { id, title, requester },
});
player.play(resource);
```
⚠️ On passthrough there is **no `resource.encoder`** → cannot setBitrate/FEC. Source
bitrate governs.

**Transcode-fallback resource (non-Opus source / loudnorm / sponsorblock):**
`inputType: StreamType.Arbitrary` (ffmpeg→PCM→Opus) → now `resource.encoder` exists:
`resource.encoder?.setBitrate(voiceChannel.bitrate)`, `.setFEC(true)`, `.setPLP(0.05)`.

**Track-end (advance trigger):** on `player.on('stateChange', (old,new)=>{ if
new.status===Idle && old.status!==Idle → advance })`. `player.on('error', e => { skip;
e.resource.metadata })`.

**Controls:** `player.pause()`, `player.unpause()`, `player.stop()`, `connection.destroy()`.

**Button picker (no extra intent):** `ActionRowBuilder<ButtonBuilder>` with
`new ButtonBuilder().setCustomId('pick:'+videoId).setLabel(String(i+1)).setStyle(ButtonStyle.Primary)`;
collect via `message.awaitMessageComponent({componentType:ComponentType.Button, time:30_000,
filter:i=>i.user.id===author.id})`; `interaction.user` = attribution.

**Feed:** download to cache file → `createReadStream` → `StreamType.WebmOpus`. (Piping
alt: `demuxProbe(proc.stdout)` → `{stream,type}`.)

---

## 3. Fastify v5 web backend

**Packages:** `fastify@^5.8`, `@fastify/cookie@^11`, `@fastify/session@^11`,
`@fastify/rate-limit@^10`, `@fastify/static@^9`, `@fastify/websocket@^11`.

**OAuth2 endpoints:** authorize `https://discord.com/oauth2/authorize` (**no `/api`**),
token `https://discord.com/api/oauth2/token`, revoke `.../oauth2/token/revoke`, identity
`https://discord.com/api/v10/users/@me`. Scope `identify guilds`.

**State CSRF:** at `/auth/login` `state=crypto.randomBytes(32).base64url`, store
`req.session.oauthState`; at `/auth/callback` consume + `crypto.timingSafeEqual` compare,
reject mismatch. Token exchange = form-urlencoded POST; **verify returned `scope`** has
identify+guilds. `await req.session.regenerate()` (rotation) then store user. Avatar:
`cdn.discordapp.com/avatars/{id}/{hash}.{png|gif}` or default `(BigInt(id)>>22n)%6n`.
`expires_in` is **seconds**; cookie maxAge is **ms**.

**Session:** `@fastify/session` server-side store (in-memory Map w/ `set/get/destroy(sid,cb)`
— swap Redis later), cookie `{httpOnly:true, secure:NODE_ENV==='production', sameSite:'lax',
path:'/', maxAge:7d-ms}`, `saveUninitialized:false`, `rolling:true`. `sameSite:'lax'` is
**required** so the cookie survives the discord.com→/auth/callback redirect. Logout =
`session.destroy()` + clearCookie + (optional) token revoke.

**canControl (bot-verified):** admin allowlist (`ADMIN_USER_IDS`, `/^\d{17,20}$/`) → true;
else `client.guilds.cache.get(guildId)` then `await guild.members.fetch(userId)` (catch →
false). OAuth `guilds` list is **UI hint only**.

**WS:** `@fastify/websocket`, handler `(socket, req)`. `onRequest` hook validates
`Origin` against allowlist (blocks cross-site WS hijack — cookies auto-sent on upgrade).
Reject anon `socket.close(1008)`. One socket, `{subscribe:guildId}`/`{unsubscribe}` topics,
authorize each via `canControl`; re-validate every 30s, close/`revoked` on loss.

**Rate-limit:** `@fastify/rate-limit` global 100/min keyed by `session.userId ?? req.ip`;
per-route stricter: `/play` 10/min, `/pick` 20/min, `/auth/login` 5/min by IP.

**Proxy:** `Fastify({ trustProxy:true })` so secure cookies + `req.ip` + protocol work
behind the home reverse proxy. Build `redirect_uri` from `PUBLIC_BASE_URL` env (must byte-
match the portal). Serve SPA via `@fastify/static` root `dist/public` + notFound→`index.html`
(except `/api`,`/ws`).

---

## 4. Scaffold / Docker / CI

**tsconfig:** `module/moduleResolution: NodeNext`, `target ES2022`, `strict`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, rootDir `src`, outDir `dist`. **Relative
imports need `.js` extension.** `web/` has its own tsconfig (DOM, `jsx:react-jsx`).

**Scripts:** `dev: tsx watch src/index.ts`, `build: build:web && build:server`,
`build:web: vite build web --outDir ../dist/public`, `build:server: tsc`, `start: node dist/index.js`,
`test: vitest run`, `typecheck: tsc --noEmit`.

**Vitest child_process mock:** `const spawnMock = vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',()=>({spawn:spawnMock}))`; fake process =
EventEmitter + `stdout: Readable.from([json])`, `queueMicrotask(()=>cp.emit('close',code))`.

**Layout:** `src/{index,config,types,youtube,cache,queue,voice,orchestrator,discord,auth,server}/`,
`web/` (Vite React), build → `dist/` (+ `dist/public`).

**Dockerfile:** stage1 `node:22.23-bookworm` (npm ci, npm run build, npm ci --omit=dev);
stage2 `node:22.23-bookworm-slim` + apt `ffmpeg python3 python3-pip ca-certificates curl unzip`
+ `pip3 install --break-system-packages "yt-dlp[default]"` + Deno via install.sh; non-root
uid 10001 `app`, `chown CACHE_DIR`; copy dist + prod node_modules; HEALTHCHECK node-fetch
`/healthz`; `CMD node dist/index.js`. (Slim Debian not Alpine — glibc smoother for native deps.)

**compose:** `image: ghcr.io/atvriders/discord-yt-music-bot:latest` (pull, `pull_policy:
always`), `env_file: .env`, volume `cache:/data/cache`, `restart: unless-stopped`,
healthcheck, json-file logging rotation, expose PORT; optional `bgutil-pot` sidecar
`profiles:["pot"]` on `:4416`.

**CI `.github/workflows/build.yml`:** `permissions:{contents:read,packages:write}`;
`on:{push:[master], workflow_dispatch, schedule: cron "0 6 * * 1"}` (weekly refresh yt-dlp);
docker login `github.actor`/`GITHUB_TOKEN`; build-push tags `:latest` + `:${{github.sha}}`;
gha cache. **Ops:** GHCR package private by default → make Public once; fork's first build
needs manual `workflow_dispatch`.
