import { EventEmitter } from "node:events";
import { GuildQueue } from "../queue/index.js";
import { Mutex } from "../util/mutex.js";
import type { Semaphore } from "../util/semaphore.js";
import type { VoiceSession } from "../voice/session.js";
import type { AudioInfo, QueueItem, Requester, TrackMeta } from "../types/index.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  type FxPreset,
  type GuildSettings,
} from "./settings.js";
import type { PlaylistStore, PlaylistSummary } from "./playlists.js";

interface DownloadResult {
  path: string;
  audio: AudioInfo | null;
}

/** Live download progress reported by youtube.download's onProgress (mirrors the youtube layer). */
interface DownloadProgress {
  percent: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

/** Per-download options threaded to youtube.download (duration scales the timeout; onProgress streams). */
interface DownloadOptions {
  durationSec?: number | null;
  onProgress?: (p: DownloadProgress) => void;
}

/**
 * The track this guild is actively FETCHING (so the panel can show it's working, not
 * stuck). `phase` walks resolving → downloading → processing; `percent` is the live
 * download completion (0–100) during the downloading phase only. Null whenever nothing
 * is being prepared (idle, or the track is already playing).
 */
export interface PreparingState {
  videoId: string;
  title: string;
  phase: "resolving" | "downloading" | "processing";
  /** Download completion 0–100; present during the downloading phase. */
  percent?: number;
}

/** Broadcast at most this often per percent advance (throttle), in addition to the time gate. */
const PREPARING_PERCENT_STEP = 5;
/** Always broadcast a percent update at least this often (ms) even on sub-step advances. */
const PREPARING_BROADCAST_MS = 1000;

/**
 * Synthetic requester attributed to tracks queued by the autoplay (YouTube radio)
 * feature, so the panel/history can tell them apart from real user requests.
 */
const AUTOPLAY_REQUESTER: Requester = {
  discordUserId: "autoplay",
  displayName: "Autoplay",
  avatarUrl: "",
  source: "autoplay",
};

/**
 * Hard cap on how many tracks autoplay may chain back-to-back before giving up and
 * idling. A safety net against a pathological radio feed that keeps returning ids we
 * have already played (which would otherwise spin without ever queueing a new track).
 */
export const AUTOPLAY_MAX_CHAIN = 50;

/**
 * Low-water mark for PROACTIVE autoplay: when the number of UPCOMING tracks falls to this
 * many or fewer (and autoplay is on), the controller tops the queue up ahead of time so
 * there is no silent gap when the user-supplied queue drains. 1 means "top up once only
 * one track is left on deck". The reactive empty-queue path (tryAutoplayLocked) still
 * covers the case where the queue genuinely hits zero.
 */
export const AUTOPLAY_LOW_WATER = 1;

/** Audio post-processing options handed to the resource factory for a single track. */
export interface AudioOptions {
  /** Pseudo-crossfade seconds (fade-out at end / fade-in at start). 0 = off. */
  crossfadeSec: number;
  /** Apply ffmpeg `loudnorm` (EBU R128) normalization. */
  normalizeLoudness: boolean;
  /** Audio FX preset appended to the ffmpeg `-af` chain. "none" = no preset. */
  fx?: FxPreset;
  /**
   * Playback volume percentage (0–200, 100 = unchanged). Applied via @discordjs/voice
   * INLINE volume on the created resource — so a non-100 value forces the PCM/transcode
   * path (no Opus passthrough). The resource factory reads this to decide whether to
   * enable inline volume and at what gain.
   */
  volumePct?: number;
}

export interface MakeResourceOpts {
  /** Start offset in ms; when > 0 the resource is produced by ffmpeg `-ss` (transcode, not Opus passthrough). */
  seekMs?: number;
  /** Per-track audio post-processing (loudnorm / pseudo-crossfade). Omitted = no processing. */
  audio?: AudioOptions;
}

export interface ControllerDeps {
  youtube: {
    download(videoId: string, outDir: string, opts?: DownloadOptions): Promise<DownloadResult>;
    /** YouTube Mix/radio for a seed video (autoplaySource "radio"). Best-effort. */
    related(videoId: string): Promise<TrackMeta[]>;
    /** More songs by the seed track's artist/channel (autoplaySource "artist"). Best-effort. */
    artistTracks(meta: TrackMeta): Promise<TrackMeta[]>;
  };
  cache: {
    get(id: string): string | null;
    getAudio(id: string): AudioInfo | null;
    has(id: string): boolean;
    register(id: string, path: string, audio?: AudioInfo | null): void;
    pin(id: string): void;
    unpin(id: string): void;
  };
  cacheDir: string;
  // The factory receives the controller's current idle timeout so freshly-created
  // sessions honor the runtime (per-guild) value, not just the static default.
  createSession: (channelId: string, idleTimeoutMs: number) => Promise<VoiceSession>;
  makeResource: (
    filePath: string,
    item: QueueItem,
    opts?: MakeResourceOpts,
  ) => unknown | Promise<unknown>;
  prefetchDepth: number;
  /** Initial idle-disconnect timeout (ms); the panel can override it per guild at runtime. */
  idleTimeoutMs: number;
  downloads: Semaphore;
  queue?: GuildQueue;
  now?: () => number;
  /** Seed for the per-guild settings (crossfade/normalize/repeat + idle). idleTimeoutSec is overridden by idleTimeoutMs. */
  settings?: GuildSettings;
  onTrackError?: (info: { videoId: string; title: string; reason: string }) => void;
  /**
   * Fired when a track actually STARTS playing (post-download, audio resource live). Used to
   * drive the bot's global Discord presence ("Listening to <title>"). Best-effort/cosmetic —
   * the host swallows any failure; it must never affect playback.
   */
  onTrackStart?: (meta: TrackMeta) => void;
  /**
   * Fired when this guild's voice session goes idle and is torn down (nothing left to play).
   * Lets the host clear/revert the global presence if this guild was the one being shown.
   */
  onIdle?: () => void;
  /** Observability hook for AudioPlayer stream errors (logging only; recovery is via trackEnd). */
  onSessionError?: (err: unknown) => void;
  /** Called after any settings mutation so the host can persist (debounced) the change. */
  onSettingsChange?: (settings: GuildSettings) => void;
  /**
   * Per-guild saved-playlist store (optional). When provided, the controller exposes
   * savePlaylist / loadPlaylist / listPlaylists / deletePlaylist backed by it. Omitted in
   * unit fixtures that don't exercise playlists — the methods then behave as no-ops.
   */
  playlists?: PlaylistStore;
}

/**
 * Snapshot shape broadcast to the panel. The current (now-playing) item gains
 * elapsed-position info; the snapshot gains a top-level `paused` flag so the UI
 * can render a moving — but display-only — progress bar.
 */
export interface ControllerSnapshot {
  current: (QueueItem & { positionMs: number; durationMs: number }) | null;
  upcoming: QueueItem[];
  history: QueueItem[];
  paused: boolean;
  /** How long (seconds) the bot stays in voice after playback ends; runtime-adjustable per guild. */
  idleTimeoutSec: number;
  /** Pseudo-crossfade seconds (0 = off). */
  crossfadeSec: number;
  /** Whether ffmpeg `loudnorm` normalization is applied. */
  normalizeLoudness: boolean;
  /** Repeat mode: off | one | all. */
  repeat: GuildSettings["repeat"];
  /** Autoplay: keep playing tracks when the queue empties. */
  autoplay: boolean;
  /** Autoplay source: "radio" (YouTube related/Mix) or "artist" (search by artist). */
  autoplaySource: GuildSettings["autoplaySource"];
  /** Per-guild max track length (seconds) accepted on enqueue; 0 = no limit. */
  maxTrackDurationSec: number;
  /** Playback volume percentage (0–200, 100 = unchanged). */
  volume: number;
  /** Audio FX preset (none | bassboost | nightcore | vaporwave | eightd | treble | karaoke). */
  fx: GuildSettings["fx"];
  /** Restrict commands/messages to this text channel id, or null = any channel (unrestricted). */
  commandChannelId: GuildSettings["commandChannelId"];
  /**
   * The track currently being FETCHED for playback (resolving/downloading/processing),
   * so the panel can show a live "⬇ Downloading … 45%" status instead of a frozen card.
   * Null when nothing is being prepared.
   */
  preparing: PreparingState | null;
}

/**
 * Minimal shape of a @discordjs/voice AudioResource the controller cares about. The
 * factory returns an opaque `unknown`; when inline volume is enabled the resource
 * exposes a `volume` knob we re-apply live on a volume change without re-creating it.
 */
interface InlineVolumeResource {
  volume?: { setVolume(value: number): void } | null;
}

export class GuildController extends EventEmitter {
  readonly queue: GuildQueue;
  private session: VoiceSession | null = null;
  private readonly lock = new Mutex();
  private readonly pinned = new Set<string>();
  private readonly now: () => number;

  // ── Autoplay state ───────────────────────────────────────────────────────────────
  // `lastPlayedMeta` is the full meta of the last-played track; it seeds the next
  // autoplay pull — by videoId for the "radio" source and by `channel`/artist for the
  // "artist" source. `autoplaySeen` tracks every videoId played or auto-queued this
  // session so we never re-enqueue a track autoplay already chained (prevents immediate
  // repeats / tight loops). `autoplayChain` counts how many tracks autoplay has queued
  // in a row without a real user enqueue, capped by AUTOPLAY_MAX_CHAIN. A user enqueue /
  // stop / leave resets these.
  private lastPlayedMeta: TrackMeta | null = null;
  private readonly autoplaySeen = new Set<string>();
  private autoplayChain = 0;
  // Guard against re-entrant autoplay attempts while one is already resolving.
  private autoplayInFlight = false;

  // ── End-of-track advance guard ────────────────────────────────────────────────────
  // A track finishing can surface as a clean `trackEnd` (player Playing->Idle), as a
  // player `error` (a stream/ffmpeg/transcode failure or EOF that never produces a clean
  // Idle transition), or as BOTH for the same track. We must advance on EITHER signal so a
  // track that ends via error alone still progresses (no "stuck at the end"), but advance
  // EXACTLY ONCE per track so an error-then-trackEnd pair doesn't double-skip.
  //
  // `playGeneration` increments every time a NEW resource starts playing (one per track
  // attempt). `advancedGeneration` records the generation whose end has already claimed an
  // advance. An end-of-track signal advances only if it hasn't been claimed for the current
  // generation; claiming is done synchronously (before the async lock) so a same-tick
  // error+trackEnd pair can't both slip through.
  private playGeneration = 0;
  private advancedGeneration = -1;

  // ── Stop/clear epoch ───────────────────────────────────────────────────────────────
  // Bumped by stop() (and leaveInternal) every time the user explicitly ends playback or the
  // session is torn down. An in-flight playItemLocked / autoplay commit captures this epoch
  // BEFORE its `await ensureDownloaded` (a network/semaphore yield) and bails if it advanced
  // while awaiting — so a Stop issued during a download can never "resurrect" playback (pin a
  // track, emit `processing`, call playResource) after the user stopped. Necessary in addition
  // to the lock because, although stop() now runs under the lock, an autoplay candidate pull
  // holds the lock ACROSS its network await; serialization alone would make stop wait for that
  // pull to finish (and still play its track). The epoch lets the post-await commit abort.
  private stopEpoch = 0;

  // Set by skip() when a skip lands DURING a track's prepare window (player Idle, so a normal
  // session.skip() emits no trackEnd and the click would be lost). playItemLocked consumes it
  // the instant the track starts playing and advances past it, so the skip isn't swallowed.
  private skipRequested = false;

  // The resource currently playing, kept so a live volume change can re-apply inline
  // volume WITHOUT re-creating the stream (the fast path for setVolume). Null when
  // nothing is playing or the current resource has no inline volume (volume === 100,
  // Opus passthrough) — in that case a volume change must re-resource at position.
  private currentResource: InlineVolumeResource | null = null;

  // Playback-position tracking for the current track. `startedAt` is the epoch
  // ms the track began; `pausedAccumMs` is the total paused time so far; while
  // paused, `pausedAt` holds the moment the pause began.
  private startedAt: number | null = null;
  private pausedAccumMs = 0;
  private pausedAt: number | null = null;

  // Per-guild settings (idle timeout + crossfade/normalize/repeat), runtime-adjustable.
  // The idle timeout is the live source of truth; `idleTimeoutMs` derives from it.
  private _settings: GuildSettings;

  // ── Preparing (live fetch) status ─────────────────────────────────────────────────
  // The track currently being fetched for playback and its phase/percent, surfaced in the
  // snapshot so the panel shows a live status. `lastPercentBroadcast`/`lastBroadcastAt`
  // throttle the high-frequency download-progress "changed" emits so they don't spam the WS.
  private preparing: PreparingState | null = null;
  private lastPercentBroadcast = -Infinity;
  private lastBroadcastAt = 0;

  constructor(
    readonly guildId: string,
    private readonly deps: ControllerDeps,
  ) {
    super();
    // Seed from deps.settings (if provided), but the explicit idleTimeoutMs always wins
    // for the idle field so existing host wiring keeps its configured default.
    this._settings = {
      ...(deps.settings ?? DEFAULT_SETTINGS),
      idleTimeoutSec: Math.round(deps.idleTimeoutMs / 1000),
    };
    this.now = deps.now ?? (() => Date.now());
    this.queue = deps.queue ?? new GuildQueue();
    this.queue.on("prefetch", (videoId: string | null) => {
      if (videoId) void this.prefetch(videoId);
    });
    this.queue.on("changed", () => {
      void this.maybeStart();
      // PROACTIVE autoplay: every queue mutation (advance/remove/enqueue) is a chance for the
      // upcoming runway to have dropped to the low-water mark. When it has — and a track is
      // still playing with autoplay on — top the queue up ahead of time so a draining queue
      // never becomes a silent gap. Best-effort + guarded (in-flight + chain cap) so it can't
      // spin; a real user enqueue resets the chain via enqueue(), as before.
      this.maybeTopUpAutoplay();
      // Re-broadcast to the panel on every queue mutation (add/remove/reorder/advance).
      this.emit("changed");
    });
  }

  get connectedChannelId(): string | null {
    return this.session?.channelId ?? null;
  }

  get isPaused(): boolean {
    return this.pausedAt !== null;
  }

  /** Current per-guild settings (copy). */
  get settings(): GuildSettings {
    return { ...this._settings };
  }

  private get idleTimeoutMs(): number {
    return this._settings.idleTimeoutSec * 1000;
  }

  /** Current idle-disconnect timeout in seconds (per-guild, runtime-adjustable). */
  getIdleTimeoutSec(): number {
    return this._settings.idleTimeoutSec;
  }

  /**
   * Set the idle-disconnect timeout (seconds). Thin wrapper over updateSettings so
   * the existing REST/panel wiring keeps working unchanged.
   */
  setIdleTimeoutSec(sec: number): void {
    this.updateSettings({ idleTimeoutSec: sec });
  }

  /**
   * Validate + merge a settings patch. Applies the resulting idle timeout to the live
   * session (restarting a running idle timer), notifies the host for persistence, and
   * emits "changed" so the panel reflects every field live. Returns the new settings.
   *
   * VOLUME / FX take effect on the CURRENT track immediately:
   *   - volume: if the live resource carries an inline-volume knob, re-apply it in place
   *     (cheap, no stream restart). Otherwise (it was an Opus passthrough at vol 100, or
   *     we're crossing 100 ⇄ non-100 which changes whether inline volume is even enabled)
   *     re-create the resource at the current position.
   *   - fx: always re-creates the resource (the preset is baked into the ffmpeg chain).
   */
  updateSettings(patch: Partial<Record<keyof GuildSettings, unknown>>): GuildSettings {
    const before = this._settings;
    this._settings = applySettingsPatch(before, patch);
    this.session?.setIdleTimeout(this.idleTimeoutMs);

    const volumeChanged = this._settings.volume !== before.volume;
    const fxChanged = this._settings.fx !== before.fx;
    if (volumeChanged || fxChanged) {
      // An fx change, or a volume change that crosses the 100 boundary (toggling the
      // passthrough/inline-volume mode), needs a fresh resource. A volume change that
      // stays non-100 (and on a resource that already has inline volume) is applied live.
      const crossed100 = volumeChanged && (before.volume === 100 || this._settings.volume === 100);
      if (fxChanged || crossed100 || !this.currentResource?.volume) {
        void this.reResourceCurrent();
      } else {
        this.applyInlineVolume(this.currentResource);
      }
    }

    this.deps.onSettingsChange?.(this._settings);
    this.emit("changed");
    return { ...this._settings };
  }

  /**
   * Set playback volume (0–200 %). Thin wrapper over updateSettings so the existing
   * persistence + live re-apply / re-resource path is reused.
   */
  setVolume(pct: number): GuildSettings {
    return this.updateSettings({ volume: pct });
  }

  /** Set the audio FX preset. Thin wrapper over updateSettings (re-resources live). */
  setFx(fx: FxPreset): GuildSettings {
    return this.updateSettings({ fx });
  }

  /**
   * Re-create the audio resource for the CURRENT track at its current playback position
   * so an audio-setting change (volume mode flip / fx preset) applies live. Reuses the
   * same seek/re-resource machinery as seek(): ffmpeg `-ss` to the current offset, the
   * current audio options (incl. the new fx/volume), preserving the paused state.
   *
   * Best-effort and serialized under the playback lock. A no-op when nothing is playing.
   */
  private async reResourceCurrent(): Promise<void> {
    await this.lock.runExclusive(async () => {
      const session = this.session;
      const current = this.queue.current;
      if (!session || !current) return;
      const positionMs = this.positionMs();
      const path = await this.ensureDownloaded(current.meta.videoId);
      if (this.session !== session) return; // torn down while awaiting the download
      current.audio = this.deps.cache.getAudio(current.meta.videoId);
      this.deps.cache.pin(current.meta.videoId);
      this.pinned.add(current.meta.videoId);
      await this.playResource(session, path, current, {
        seekMs: positionMs,
        audio: this.audioOptions(),
      });
      // Re-READ the live pause intent AFTER the await (don't capture it before the download):
      // a pause()/resume() that landed during the yield must win, or it would be silently
      // overwritten by a stale pre-await snapshot.
      const paused = this.pausedAt !== null;
      if (paused) session.pause();
      else session.resume();
      // Re-anchor so the moving bar resumes exactly where it was (preserving pause).
      this.markTrackStarted(positionMs, true);
      this.emit("changed");
    });
  }

  // ── Preparing-status helpers ──────────────────────────────────────────────────────

  /**
   * Set the live "preparing" status to a new phase and broadcast it. A phase TRANSITION
   * (or clearing to null) always emits; the per-percent downloading updates go through
   * `updatePreparingPercent` instead, which throttles. Resets the throttle accumulators on
   * every transition so the first percent of a new phase always lands.
   */
  private setPreparing(state: PreparingState | null): void {
    this.preparing = state;
    this.lastPercentBroadcast = state?.percent ?? -Infinity;
    this.lastBroadcastAt = this.now();
    this.emit("changed");
  }

  /**
   * Update the live download percent, broadcasting only when it advances by at least
   * PREPARING_PERCENT_STEP since the last broadcast OR PREPARING_BROADCAST_MS has elapsed
   * (so a slow trickle still updates ~1×/s). This keeps a long download from spamming the
   * WS with a "changed" on every yt-dlp progress line. A no-op once we've moved past the
   * downloading phase (a late progress line must not resurrect a stale status).
   */
  private updatePreparingPercent(percent: number): void {
    const p = this.preparing;
    if (!p || p.phase !== "downloading") return;
    p.percent = percent;
    const now = this.now();
    const advanced = percent - this.lastPercentBroadcast >= PREPARING_PERCENT_STEP;
    const timeElapsed = now - this.lastBroadcastAt >= PREPARING_BROADCAST_MS;
    // Always let 100% through so the bar visibly completes before processing.
    if (advanced || timeElapsed || percent >= 100) {
      this.lastPercentBroadcast = percent;
      this.lastBroadcastAt = now;
      this.emit("changed");
    }
  }

  /** Audio post-processing options derived from current settings. */
  private audioOptions(): AudioOptions {
    return {
      crossfadeSec: this._settings.crossfadeSec,
      normalizeLoudness: this._settings.normalizeLoudness,
      fx: this._settings.fx,
      volumePct: this._settings.volume,
    };
  }

  /**
   * Build the audio resource for `path`/`item`, apply the current INLINE volume to it
   * (so a non-100 volume is honored from the first frame), remember it as the current
   * resource for live volume changes, and hand it to the session to play.
   */
  private async playResource(
    session: VoiceSession,
    path: string,
    item: QueueItem,
    opts?: MakeResourceOpts,
  ): Promise<void> {
    const resource = (await this.deps.makeResource(path, item, opts)) as InlineVolumeResource;
    this.applyInlineVolume(resource);
    this.currentResource = resource;
    // A fresh resource is now the live track: open a new advance "generation" so the next
    // end-of-track signal (trackEnd OR error) is eligible to advance exactly once. (Seek /
    // re-resource go through here too; they replace the live stream, so re-arming the guard
    // is correct — the previous resource's end is no longer something we should advance on.)
    this.playGeneration += 1;
    session.play(resource);
  }

  /** Apply the current per-guild volume to a resource's inline volume knob, if present. */
  private applyInlineVolume(resource: InlineVolumeResource | null): void {
    resource?.volume?.setVolume(this._settings.volume / 100);
  }

  /** Elapsed ms of the current track, excluding paused time. */
  private positionMs(): number {
    if (this.startedAt === null) return 0;
    const pausedNow = this.pausedAt !== null ? this.now() - this.pausedAt : 0;
    const elapsed = this.now() - this.startedAt - this.pausedAccumMs - pausedNow;
    return Math.max(0, elapsed);
  }

  // (Re-)anchor position tracking so the current track reads `baseMs` elapsed right
  // now. A fresh track starts at 0; a seek re-anchors to the seek target. When the
  // track is currently paused (`keepPaused`), the frozen point moves to the new base
  // so the position stays put after a scrub while paused.
  private markTrackStarted(baseMs = 0, keepPaused = false): void {
    const paused = keepPaused && this.pausedAt !== null;
    this.startedAt = this.now() - baseMs;
    this.pausedAccumMs = 0;
    this.pausedAt = paused ? this.now() : null;
  }

  snapshot(): ControllerSnapshot {
    const snap = this.queue.snapshot();
    const current = snap.current
      ? {
          ...snap.current,
          positionMs: this.positionMs(),
          durationMs:
            snap.current.meta.durationSec && snap.current.meta.durationSec > 0
              ? snap.current.meta.durationSec * 1000
              : 0,
        }
      : null;
    return {
      current,
      upcoming: snap.upcoming,
      history: snap.history,
      paused: this.isPaused,
      idleTimeoutSec: this._settings.idleTimeoutSec,
      crossfadeSec: this._settings.crossfadeSec,
      normalizeLoudness: this._settings.normalizeLoudness,
      repeat: this._settings.repeat,
      autoplay: this._settings.autoplay,
      autoplaySource: this._settings.autoplaySource,
      maxTrackDurationSec: this._settings.maxTrackDurationSec,
      volume: this._settings.volume,
      fx: this._settings.fx,
      commandChannelId: this._settings.commandChannelId,
      preparing: this.preparing ? { ...this.preparing } : null,
    };
  }

  async restore(channelId: string, items: QueueItem[]): Promise<void> {
    await this.ensureConnected(channelId);
    // restore() DELIBERATELY bypasses the maxTrackDurationSec cap: it re-instates the exact
    // queue (including the track that was already playing) from a pre-restart snapshot — a
    // trusted internal state recovery, not a user-initiated load — so enforcing the cap here
    // would wrongly drop a track that was legitimately mid-play before the restart. Per-item
    // shape is validated so a partial/corrupt snapshot write can't crash the whole restore.
    for (const it of items) {
      if (
        typeof it?.meta?.videoId !== "string" ||
        typeof it?.requester?.discordUserId !== "string"
      ) {
        // Skip a malformed item rather than letting queue.add destructure null and throw,
        // which would abort the loop and drop EVERY remaining (good) item for this guild.
        continue;
      }
      await this.queue.add(it.meta, it.requester);
    }
    // maybeStart fires via the queue "changed" listener.
  }

  // Inline session create + listener wiring (shared by ensureConnected and moveTo; NOT locked itself).
  private async connectSessionLocked(channelId: string): Promise<void> {
    const session = await this.deps.createSession(channelId, this.idleTimeoutMs);
    // A finishing track advances on EITHER a clean `trackEnd` (player Playing->Idle) OR a
    // terminal player `error` — many stream/ffmpeg/EOF failures surface only as `error`
    // without a clean Idle transition, so relying on `trackEnd` alone leaves the track
    // STUCK at the end. `advanceOnTrackEnd` claims a per-track guard so when BOTH fire for
    // the same track (the common error-then-Idle case) the queue still advances exactly
    // once (no double-skip).
    session.on("trackEnd", () => {
      if (this.session === session) this.advanceOnTrackEnd(session);
    });
    session.on("error", (err: unknown) => {
      if (this.session !== session) return;
      // Observability first (logging only — never throws), then drive recovery.
      this.deps.onSessionError?.(err);
      // A player `error` means this track FAILED (its resource errored — a demux/ffmpeg/EOF
      // failure), as opposed to a clean Playing->Idle `trackEnd` which means it played and
      // finished. A failure must SURFACE ("✕ Couldn't play …") and be skipped WITHOUT being
      // archived to history as a normally-played song (otherwise it silently lands in
      // history and Replay just re-adds a song that re-fails). Distinct path from trackEnd.
      this.failCurrentTrack(session, err);
    });
    // Idle teardown must run under the same Mutex as the playback paths, or it can destroy
    // the session mid-download (while playNextLocked yields on ensureDownloaded), causing
    // play() on a dead session and a leaked pin. Serialize via leaveInternal under the lock.
    session.on("idle", () => {
      if (this.session === session) void this.lock.runExclusive(() => this.leaveInternal());
    });
    this.session = session;
  }

  async ensureConnected(channelId: string): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (this.session) return;
      await this.connectSessionLocked(channelId);
    });
  }

  /** Admin move: relocate to a new channel, resuming the current track from 0 (or starting the queue). */
  async moveTo(channelId: string): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (this.session && this.session.channelId === channelId) return; // already there
      const current = this.queue.current;
      this.session?.destroy();
      this.session = null;
      await this.connectSessionLocked(channelId);
      if (current) await this.playItemLocked(current);
      else await this.playNextLocked();
    });
  }

  /**
   * Whether a track exceeds this guild's authoritative max-track-length cap.
   * 0 = no limit; a null/unknown duration is always allowed (returns false). Shared by
   * enqueue() (which throws) and loadPlaylist() (which skips) so the cap is enforced
   * uniformly across both the manual-enqueue and saved-playlist paths.
   */
  private exceedsDurationCap(meta: TrackMeta): boolean {
    const limit = this._settings.maxTrackDurationSec;
    return limit > 0 && meta.durationSec !== null && meta.durationSec > limit;
  }

  async enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
    // Per-guild max-track-length guard — the AUTHORITATIVE cap (panel-controlled),
    // superseding the global config. 0 = no limit; a null/unknown duration is always
    // allowed. Autoplay's best-effort feed (synthetic requester) bypasses this; it
    // enqueues via queue.add directly and should never be killed by the cap.
    if (requester.source !== "autoplay" && this.exceedsDurationCap(meta)) {
      const limit = this._settings.maxTrackDurationSec;
      const hours = +(limit / 3600).toFixed(2);
      throw new YtError(
        YtErrorKind.TooLong,
        `Too long — max ${hours}h (track is ${meta.durationSec}s, over the ${limit}s limit)`,
      );
    }
    // A real user enqueue resets the autoplay chain budget: autoplay only kicks in once the
    // user-supplied queue has genuinely run dry, and should get a fresh cap then. Kept
    // synchronous (NOT under the playback lock) on purpose: an in-flight playItemLocked holds
    // the lock across its download, so taking the lock here would block a user enqueue on that
    // download — a regression. The narrow remaining race (an autoplay pull incrementing
    // autoplayChain between this reset and its own commit) only nudges the chain COUNT by one
    // and is self-correcting on the next real enqueue; it never affects which tracks play.
    if (requester.source !== "autoplay") this.autoplayChain = 0;
    const item = await this.queue.add(meta, requester);
    await this.maybeStart();
    return item;
  }

  skip(): void {
    if (!this.session) return;
    // If a track is mid-PREPARE (downloading/processing, not yet playing), the player is Idle,
    // so session.skip() -> player.stop() emits no fresh trackEnd and the click would be lost.
    // Record the intent; playItemLocked consumes it right after the track starts and advances
    // immediately, so a skip during the prepare window isn't swallowed.
    if (this.preparing !== null) {
      this.skipRequested = true;
      return;
    }
    this.session.skip(); // emits trackEnd -> advance -> queue "changed" -> broadcast
  }
  pause(): void {
    if (this.session && this.pausedAt === null) {
      this.session.pause();
      this.pausedAt = this.now();
      this.emit("changed");
    }
  }
  resume(): void {
    if (this.session && this.pausedAt !== null) {
      this.session.resume();
      this.pausedAccumMs += this.now() - this.pausedAt;
      this.pausedAt = null;
      this.emit("changed");
    }
  }
  /**
   * Scrub to `positionMs` within the current track. Opus frames aren't randomly
   * seekable, so we re-create the audio resource from the cached file starting at the
   * offset via ffmpeg `-ss` (a transcode, not a passthrough), play it, re-anchor the
   * position so the moving bar jumps to the target, and broadcast the new state.
   *
   * Because ffmpeg has to re-open and transcode from the offset, there is a brief
   * audible gap (typically well under a second) while the new stream spins up. The
   * paused state is preserved across the seek.
   *
   * @returns true if a seek was performed, false if there is nothing playing.
   * @throws RangeError if positionMs is out of [0, durationMs].
   */
  async seek(positionMs: number): Promise<boolean> {
    return this.lock.runExclusive(async () => {
      const session = this.session;
      const current = this.queue.current;
      if (!session || !current) return false;
      const durationSec = current.meta.durationSec;
      const max = durationSec && durationSec > 0 ? durationSec * 1000 : Infinity;
      if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs > max) {
        throw new RangeError("positionMs out of range");
      }
      const path = await this.ensureDownloaded(current.meta.videoId);
      current.audio = this.deps.cache.getAudio(current.meta.videoId);
      this.deps.cache.pin(current.meta.videoId);
      this.pinned.add(current.meta.videoId);
      await this.playResource(session, path, current, {
        seekMs: positionMs,
        audio: this.audioOptions(),
      });
      // A fresh resource always starts playing; re-READ the live pause intent AFTER the
      // download await (not a pre-await snapshot) so a pause()/resume() issued DURING the seek
      // wins and isn't silently overwritten. The player just started, so an unpaused intent
      // needs no action, but an explicit resume() keeps the two in sync.
      const paused = this.pausedAt !== null;
      if (paused) session.pause();
      else session.resume();
      this.markTrackStarted(positionMs, true);
      this.emit("changed");
      return true;
    });
  }
  async remove(itemId: string): Promise<boolean> {
    return this.queue.remove(itemId);
  }
  async reorder(itemId: string, toIndex: number): Promise<boolean> {
    return this.queue.reorder(itemId, toIndex);
  }
  /** Shuffle the upcoming list (Fisher-Yates). `rng` is injectable for deterministic tests. */
  async shuffle(rng?: () => number): Promise<void> {
    return this.queue.shuffle(rng);
  }
  /**
   * Skip straight to a chosen upcoming item: drop every upcoming item BEFORE it (they are
   * removed, not archived as played history), then advance so the target becomes current
   * and starts playing. Returns false if the id isn't in the upcoming list. The drop +
   * advance run under the playback lock so they can't interleave with a concurrent
   * trackEnd/autoplay advance.
   */
  async jumpTo(itemId: string): Promise<boolean> {
    return this.lock.runExclusive(async () => {
      const upcoming = this.queue.snapshot().upcoming;
      const idx = upcoming.findIndex((i) => i.id === itemId);
      if (idx === -1) return false;
      // Drop the items strictly before the target so it sits at the head of upcoming.
      for (let i = 0; i < idx; i++) await this.queue.remove(upcoming[i]!.id);
      // Advance unconditionally to the target (archives the current track and promotes the
      // now-head target), then play it. We bypass playNextLocked deliberately: its repeat="one"
      // branch would replay the current track instead of honoring the explicit jump.
      const target = await this.queue.advance();
      if (target) await this.playItemLocked(target);
      return true;
    });
  }
  async stop(): Promise<void> {
    // Invalidate any in-flight prepare/autoplay commit SYNCHRONOUSLY, before we even queue for
    // the lock. An in-flight playItemLocked holds the lock across its `await ensureDownloaded`,
    // so a stop() that only bumped the epoch INSIDE the lock would run AFTER that download
    // resumed — too late, the track would already have pinned + played. Bumping here means the
    // resumed playItemLocked's post-await `this.stopEpoch !== epoch` check fires immediately,
    // so it bails BEFORE pinning/playing (no transient playback, no leaked pin).
    this.stopEpoch += 1;
    this.skipRequested = false;
    // Then run the state teardown under the playback lock so it serializes cleanly with the
    // (now-aborting) in-flight operation and can't interleave with a concurrent advance.
    await this.lock.runExclusive(async () => {
      await this.queue.clear();
      // An explicit stop ends the autoplay chain — it must not silently refill the queue.
      this.lastPlayedMeta = null;
      this.autoplaySeen.clear();
      this.autoplayChain = 0;
      // Reset position/pause tracking (mirrors leaveInternal) so a pause()→stop() sequence
      // doesn't leave isPaused stuck true and emit { paused: true } over an empty queue.
      this.startedAt = null;
      this.pausedAt = null;
      this.pausedAccumMs = 0;
      this.currentResource = null;
      // Drop any in-flight preparing status so the panel doesn't keep showing a fetch the
      // user just stopped (the epoch bump above also aborts the awaiting playItemLocked).
      this.preparing = null;
      this.session?.stop();
      // Stay in the voice channel after Stop; the normal idle timeout disconnects later.
      this.session?.startIdleTimer();
      this.emit("changed");
    });
  }

  // ── Saved playlists (per-guild, persisted via deps.playlists) ─────────────────────
  // These delegate to the optional PlaylistStore. When no store is wired (unit fixtures),
  // list/delete report "nothing" and save/load are inert, so the controller never throws
  // merely because playlists weren't configured.

  /**
   * Save the CURRENT track plus everything UPCOMING as a named playlist for this guild
   * (in play order). History is intentionally excluded — a playlist is "what is/was about
   * to play", matching what a user sees as the live queue. Throws if the queue is empty
   * (nothing to save) or the name is blank.
   */
  async savePlaylist(name: string): Promise<void> {
    if (!this.deps.playlists) return;
    const snap = this.queue.snapshot();
    const metas = [...(snap.current ? [snap.current] : []), ...snap.upcoming].map((i) => i.meta);
    await this.deps.playlists.save(this.guildId, name, metas);
  }

  /**
   * Enqueue every track of a named playlist for this guild, attributed to `requester`, in
   * saved order. Returns how many tracks were actually enqueued (0 when the playlist doesn't
   * exist or no store is wired).
   *
   * Applies the SAME authoritative per-guild maxTrackDurationSec cap that enqueue() applies —
   * a track over the limit is SKIPPED (not enqueued), so the returned count reflects only the
   * tracks that were accepted. (A saved playlist must not be a back door around an admin's
   * length cap.) Like a real user enqueue, this also resets the autoplay chain so the loaded
   * tracks get a fresh follow-on autoplay budget, and calls maybeStart() so the bot begins
   * playing if idle and the usual queue events/broadcasts fire.
   */
  async loadPlaylist(name: string, requester: Requester): Promise<number> {
    const tracks = this.deps.playlists?.get(this.guildId, name);
    if (!tracks || tracks.length === 0) return 0;
    // A real user-initiated load resets the autoplay chain budget (mirrors enqueue()), so the
    // freshly loaded queue gets a full AUTOPLAY_MAX_CHAIN follow-on budget. Synchronous, for
    // the same reason enqueue()'s reset is (see there): taking the lock would block on an
    // in-flight download.
    if (requester.source !== "autoplay") this.autoplayChain = 0;
    let added = 0;
    for (const meta of tracks) {
      // Enforce the authoritative cap here too (enqueue() throws; a playlist load skips so one
      // over-limit track can't abort the whole load). Autoplay-sourced loads bypass, as enqueue.
      if (requester.source !== "autoplay" && this.exceedsDurationCap(meta)) continue;
      await this.queue.add(meta, requester);
      added += 1;
    }
    await this.maybeStart();
    return added;
  }

  /** Summaries of this guild's saved playlists (empty when no store is wired). */
  listPlaylists(): PlaylistSummary[] {
    return this.deps.playlists?.list(this.guildId) ?? [];
  }

  /** Delete a named playlist for this guild; returns whether it existed. */
  async deletePlaylist(name: string): Promise<boolean> {
    if (!this.deps.playlists) return false;
    return this.deps.playlists.delete(this.guildId, name);
  }

  private async maybeStart(): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (!this.session) return;
      if (this.queue.current) return; // already playing
      if (this.queue.snapshot().upcoming.length === 0) return;
      await this.playNextLocked();
    });
  }

  /**
   * Handle an end-of-track signal (a clean `trackEnd` OR a terminal player `error`) by
   * advancing the queue EXACTLY ONCE per track. Both signals can fire for the same track
   * (a stream error typically also drives the player to Idle), so we claim a per-track
   * guard SYNCHRONOUSLY here — before yielding to the async lock — so a same-tick
   * error+trackEnd pair can't both advance and double-skip. The first signal for a given
   * play generation claims the advance; any later signal for that same generation is a
   * no-op until a new track starts playing (which opens the next generation).
   */
  private advanceOnTrackEnd(session: VoiceSession): void {
    if (this.advancedGeneration === this.playGeneration) return; // already advanced this track
    this.advancedGeneration = this.playGeneration;
    void this.lock.runExclusive(async () => {
      // The session may have been torn down/replaced while this was queued behind the lock.
      if (this.session !== session) return;
      await this.playNextLocked();
    });
  }

  /**
   * Handle a player `error` for the CURRENT track: a play-time FAILURE (the audio resource
   * errored — demux/ffmpeg/EOF), NOT a clean finish. Claims the SAME per-track advance guard
   * as `advanceOnTrackEnd` (synchronously, before yielding to the async lock) so an
   * error+trackEnd pair for one track still advances exactly once and can't double-skip.
   *
   * Unlike a clean `trackEnd` (which archives the played track to history via the normal
   * advance), a failure SURFACES `onTrackError` so the panel shows "✕ Couldn't play —
   * <reason>", and the failed track is DISCARDED (dropped, not historied) before playing the
   * next — a song that never played must not be recorded as a completed play (which would
   * make Replay re-add a track that silently re-fails). The stuck-at-end fix is preserved:
   * an error still drives the queue forward, never leaving the track stuck.
   */
  private failCurrentTrack(session: VoiceSession, err: unknown): void {
    if (this.advancedGeneration === this.playGeneration) return; // already advanced this track
    this.advancedGeneration = this.playGeneration;
    // Capture the failed track's identity + reason BEFORE the async advance mutates `current`.
    const failed = this.queue.current;
    const reason = err instanceof Error ? err.message : "playback_failed";
    if (failed) {
      this.deps.onTrackError?.({
        videoId: failed.meta.videoId,
        title: failed.meta.title,
        reason,
      });
    }
    void this.lock.runExclusive(async () => {
      // The session may have been torn down/replaced while this was queued behind the lock.
      if (this.session !== session) return;
      await this.discardAndPlayNextLocked();
    });
  }

  private async playNext(): Promise<void> {
    return this.lock.runExclusive(() => this.playNextLocked());
  }

  // Plays a specific item in the current session WITHOUT advancing the queue. Returns false on failure.
  private async playItemLocked(item: QueueItem): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    // Capture the stop/teardown epoch BEFORE the download yield. If stop() / leaveInternal()
    // bumps it while we await, the prepare is stale and must abort (no pin / no playResource).
    const epoch = this.stopEpoch;
    try {
      // Surface a live "preparing" status so the panel shows the track is actively being
      // fetched (resolving → downloading → processing) rather than looking frozen. The
      // downloading phase + percent is set inside ensureDownloaded (only on a cache miss).
      this.setPreparing({ videoId: item.meta.videoId, title: item.meta.title, phase: "resolving" });
      const path = await this.ensureDownloaded(item.meta.videoId, {
        title: item.meta.title,
        durationSec: item.meta.durationSec,
      });
      // Defense-in-depth: ensureDownloaded yields, so a teardown (leaveInternal) could have
      // replaced/destroyed the session while we awaited. Never play onto a stale session or
      // pin against a cleared `pinned` set. The stopEpoch check additionally catches an
      // explicit stop() that KEPT the same session alive (so the identity check passes) but
      // cleared the queue/status — without it, a Stop during the download would resume play.
      if (this.session !== session || this.stopEpoch !== epoch) {
        this.setPreparing(null);
        return false;
      }
      item.audio = this.deps.cache.getAudio(item.meta.videoId);
      this.deps.cache.pin(item.meta.videoId);
      this.pinned.add(item.meta.videoId);
      // The file is on disk; building the ffmpeg/Opus resource is the final "processing"
      // step (transcode/passthrough setup) before the first frame plays.
      this.setPreparing({
        videoId: item.meta.videoId,
        title: item.meta.title,
        phase: "processing",
      });
      await this.playResource(session, path, item, { audio: this.audioOptions() });
      // Track has started — clear the preparing status (broadcast happens below via the
      // final emit("changed"), but null it BEFORE markTrackStarted so the snapshot the
      // panel receives shows the now-playing card, not a lingering "processing").
      this.preparing = null;
      this.markTrackStarted();
      // Remember what just started so autoplay can seed its next pull from it (by id for
      // radio, by artist/channel for artist), and record the id so autoplay never
      // re-queues a track we've already played.
      this.lastPlayedMeta = item.meta;
      this.autoplaySeen.add(item.meta.videoId);
      // Drive the bot's global Discord presence ("Listening to <title>"). Best-effort:
      // the host swallows failures; a presence hiccup must never affect playback.
      this.deps.onTrackStart?.(item.meta);
      // Re-broadcast now that the new track has actually started: the "changed"
      // fired from queue.advance() ran BEFORE markTrackStarted(), so the panel's
      // now-playing snapshot for this track still carried the PREVIOUS track's
      // elapsed position. Emit again so the panel gets the freshly-started track
      // with its position reset (no stale now-playing card after a skip/advance).
      this.emit("changed");
      // A skip that arrived DURING this track's prepare window (player was Idle) was recorded
      // rather than lost. Now that the track is actually playing, honor it: session.skip()
      // emits trackEnd -> advanceOnTrackEnd (which serializes behind this lock release) so the
      // queue moves past the track the user skipped before it really started.
      if (this.skipRequested) {
        this.skipRequested = false;
        this.session?.skip();
      }
      return true;
    } catch (err) {
      // The fetch failed — clear the live status (and broadcast) so the panel drops the
      // "downloading/processing" indicator instead of leaving it spinning forever.
      this.setPreparing(null);
      this.deps.onTrackError?.({
        videoId: item.meta.videoId,
        title: item.meta.title,
        reason: err instanceof YtError ? err.kind : "download_failed",
      });
      return false;
    }
  }

  /**
   * Advance past a FAILED current track: DISCARD it (drop without archiving to history —
   * it never played), promote the head of upcoming, and play it; on a further failure keep
   * skipping (each via the normal historying advance, since those are real advances of
   * tracks we attempted). Falls back to autoplay/idle exactly like playNextLocked when the
   * queue empties.
   *
   * `repeat="one"` is deliberately NOT honored for a failed track — replaying a track that
   * just errored would loop the failure forever. The discard moves us off it. Subsequent
   * clean ends resume normal repeat behavior.
   */
  private async discardAndPlayNextLocked(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // Drop the failed current (no history), promote the next, and play it.
    let item = await this.queue.discardCurrent();
    while (item) {
      if (await this.playItemLocked(item)) return;
      // A subsequent download/play failure for the promoted track must ALSO be discarded (not
      // historied): it never played, so archiving it would let Replay re-add a track that
      // re-fails. advance() here would wrongly push the just-failed track into history.
      item = await this.queue.discardCurrent();
    }
    if (await this.tryAutoplayLocked()) return;
    this.currentResource = null;
    session.startIdleTimer();
  }

  private async playNextLocked(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // Repeat "one": replay the current track without advancing the queue.
    if (this._settings.repeat === "one") {
      const current = this.queue.current;
      if (current && (await this.playItemLocked(current))) return;
      // current missing or failed → fall through to normal advance.
    }
    // Repeat "all": when the queue has run dry, cycle the played history back in.
    if (this._settings.repeat === "all" && this.queue.snapshot().upcoming.length === 0) {
      await this.queue.requeueHistory();
    }
    let item = await this.queue.advance();
    while (item) {
      if (await this.playItemLocked(item)) return;
      // The promoted track FAILED to play (download/resolve error) — it never played, so
      // discard it (no history) rather than advance() (which would archive it and let Replay
      // re-add a track that re-fails). The ENTRY advance() above is correct: the previous
      // current finished cleanly via trackEnd and belongs in history.
      item = await this.queue.discardCurrent();
    }
    // Nothing left in the queue. If autoplay is on, try to keep the music going with
    // YouTube's radio for the last track before falling back to idling.
    if (await this.tryAutoplayLocked()) return;
    // The queue ran dry naturally: nothing is playing any more, so drop the reference to
    // the just-finished resource (already cleared on stop/teardown). Leaving it stale lets
    // a later live volume change re-apply onto a dead resource.
    this.currentResource = null;
    session.startIdleTimer();
  }

  /**
   * Resolve the next NEW autoplay candidate (a track not already played/seen this session)
   * for the current source, applying ALL the shared autoplay bookkeeping exactly once:
   *   - guards: autoplay off / no seed / already in-flight / chain cap reached → null,
   *   - source branch: "radio" → youtube.related(id); "artist" → youtube.artistTracks(meta),
   *   - seen-id de-dup (skips ids we've already played/queued, incl. the seed),
   *   - on a hit: marks the id seen up-front and bumps autoplayChain so a play failure can't
   *     re-pick it and the chain stays bounded.
   *
   * Best-effort: a fetch that throws or yields nothing new resolves to null. The CALLER owns
   * the in-flight flag (it must wrap the whole add+play, not just this lookup) — this helper
   * only reads it as a guard. Returns the candidate meta, or null to fall back to idle.
   *
   * HONESTY: neither source is a precise genre classifier — "radio" is YouTube's related
   * feed, "artist" a name-based search, both keyed on the single last track.
   */
  private async nextAutoplayCandidate(): Promise<TrackMeta | null> {
    if (!this._settings.autoplay) return null;
    const seed = this.lastPlayedMeta;
    if (seed === null) return null;
    if (this.autoplayChain >= AUTOPLAY_MAX_CHAIN) return null;

    let candidates: TrackMeta[];
    try {
      // Branch the SOURCE only; the de-dup + chain bookkeeping below is shared.
      candidates =
        this._settings.autoplaySource === "artist"
          ? await this.deps.youtube.artistTracks(seed)
          : await this.deps.youtube.related(seed.videoId);
    } catch {
      return null; // source lookup failed — fall back to idle
    }
    const next = candidates.find(
      (c) => c.videoId && !c.isLive && !this.autoplaySeen.has(c.videoId),
    );
    if (!next) return null;

    // Mark seen up-front so a play failure doesn't re-pick the same id on retry, and count
    // it against the chain cap (shared with the empty-queue path).
    this.autoplaySeen.add(next.videoId);
    this.autoplayChain += 1;
    return next;
  }

  /**
   * Autoplay (REACTIVE, empty-queue): the queue ran dry and `settings.autoplay` is on, so
   * fetch the next NEW candidate, promote it to current, and play it. Reuses the shared
   * candidate helper (source branch + seen-id de-dup + chain cap) and the in-flight guard.
   *
   * Best-effort: any failure (no new candidate, or the download/play fails) resolves to
   * `false`, letting the caller idle exactly as it does today.
   */
  private async tryAutoplayLocked(): Promise<boolean> {
    if (this.autoplayInFlight) return false;
    this.autoplayInFlight = true;
    // Capture the stop/teardown epoch before the candidate network pull. A Stop (or teardown)
    // during the await must cancel this commit rather than enqueue+play a track over a queue
    // the user just cleared.
    const epoch = this.stopEpoch;
    try {
      const next = await this.nextAutoplayCandidate();
      if (!next) return false;
      if (this.stopEpoch !== epoch) return false; // stopped/torn-down while resolving
      await this.queue.add(next, AUTOPLAY_REQUESTER);
      // advance() promotes the freshly-added upcoming item to current, then play it.
      const promoted = await this.queue.advance();
      if (promoted && (await this.playItemLocked(promoted))) return true;
      // Download/play failed: leave the (now-seen) id behind and let the caller idle.
      return false;
    } finally {
      this.autoplayInFlight = false;
    }
  }

  /**
   * Autoplay (PROACTIVE, low-water top-up): when UPCOMING has fallen to AUTOPLAY_LOW_WATER
   * or fewer tracks while something is still playing and `settings.autoplay` is on, APPEND
   * one fresh candidate to the END of the queue so the user-supplied queue draining never
   * leaves a silent gap. Unlike tryAutoplayLocked this does NOT advance/skip — the current
   * track keeps playing; the appended track simply becomes the next "up next".
   *
   * Reuses the EXACT same bookkeeping (source branch, seen-id de-dup, chain cap, in-flight
   * guard) via nextAutoplayCandidate — only the queue mutation differs (add, no advance).
   * Best-effort: a no-candidate / fetch failure is a silent no-op; the reactive empty-queue
   * path still covers a true drain.
   */
  private async topUpAutoplayLocked(): Promise<void> {
    if (!this.session) return;
    if (!this._settings.autoplay) return;
    // Only top up while a track is actually playing and the runway is LOW. An empty/idle
    // queue is the reactive path's job (tryAutoplayLocked), not the top-up's.
    if (!this.queue.current) return;
    if (this.queue.snapshot().upcoming.length > AUTOPLAY_LOW_WATER) return;
    if (this.autoplayInFlight) return;

    this.autoplayInFlight = true;
    // Capture the stop/teardown epoch before the candidate pull so a Stop during the await
    // cancels the top-up append instead of refilling a queue the user just cleared.
    const epoch = this.stopEpoch;
    try {
      const next = await this.nextAutoplayCandidate();
      if (!next) return;
      if (this.stopEpoch !== epoch) return; // stopped/torn-down while resolving
      // Append only — the current track keeps playing; this becomes the next "up next".
      await this.queue.add(next, AUTOPLAY_REQUESTER);
    } finally {
      this.autoplayInFlight = false;
    }
  }

  /**
   * Fire-and-forget proactive top-up off the queue "changed" stream. Serializes under the
   * playback lock (so it can't interleave with an advance/teardown) and is fully
   * best-effort — any failure is swallowed and the queue simply idles via the reactive path.
   */
  private maybeTopUpAutoplay(): void {
    if (!this._settings.autoplay) return;
    void this.lock.runExclusive(() => this.topUpAutoplayLocked());
  }

  /**
   * Ensure the track is on disk, returning its cached path. When `prepare` is supplied
   * (the play-for-playback path) and the file is NOT already cached, the live preparing
   * status advances to "downloading" and the download's onProgress streams into
   * `preparing.percent` (throttled). A cache hit skips the download (and the downloading
   * phase) entirely. The caller owns clearing/advancing the status afterwards.
   */
  private async ensureDownloaded(
    videoId: string,
    prepare?: { title: string; durationSec: number | null },
  ): Promise<string> {
    const cached = this.deps.cache.get(videoId);
    if (cached) return cached;
    if (prepare) {
      this.setPreparing({ videoId, title: prepare.title, phase: "downloading", percent: 0 });
    }
    const { path, audio } = await this.deps.downloads.run(() =>
      this.deps.youtube.download(videoId, this.deps.cacheDir, {
        durationSec: prepare?.durationSec,
        onProgress: prepare ? (p) => this.updatePreparingPercent(p.percent) : undefined,
      }),
    );
    this.deps.cache.register(videoId, path, audio);
    return path;
  }

  private async prefetch(videoId: string): Promise<void> {
    if (this.deps.cache.has(videoId)) return;
    try {
      const { path, audio } = await this.deps.downloads.run(() =>
        this.deps.youtube.download(videoId, this.deps.cacheDir),
      );
      this.deps.cache.register(videoId, path, audio);
      // prefetch runs outside the lock and yields at the download await; a leaveInternal()
      // may have torn the session down (clearing `pinned`) while we waited. If so, don't
      // write into the now-orphaned pinned Set — drop the pin so the entry stays
      // LRU-evictable instead of being pinned forever.
      if (!this.session) {
        this.deps.cache.unpin(videoId);
        return;
      }
      this.deps.cache.pin(videoId);
      this.pinned.add(videoId);
    } catch {
      // prefetch is best-effort; a real failure surfaces when the track is played
    }
  }

  // NOT locked: callers must hold the Mutex (the idle handler wraps this in
  // lock.runExclusive). This serializes teardown with playNextLocked/playItemLocked so
  // the session can't be destroyed while a download is in flight.
  private leaveInternal(): void {
    // A teardown also invalidates any in-flight prepare/autoplay commit (same rationale as
    // stop()): a download awaiting completion must not pin/play onto the destroyed session.
    this.stopEpoch += 1;
    this.skipRequested = false;
    this.session?.destroy();
    this.session = null;
    this.currentResource = null;
    this.startedAt = null;
    this.pausedAt = null;
    this.pausedAccumMs = 0;
    // A teardown cancels any in-flight fetch's relevance; clear the status so the panel
    // doesn't keep showing a "downloading/processing" for a session that no longer exists.
    this.preparing = null;
    for (const id of this.pinned) this.deps.cache.unpin(id);
    this.pinned.clear();
    // Forget the autoplay chain so a future session starts fresh.
    this.lastPlayedMeta = null;
    this.autoplaySeen.clear();
    this.autoplayChain = 0;
    // Nothing is playing in this guild any more — let the host clear/revert the global
    // Discord presence if this guild was the one being shown. Best-effort/cosmetic.
    this.deps.onIdle?.();
  }
}
