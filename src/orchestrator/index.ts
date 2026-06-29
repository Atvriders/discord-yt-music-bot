import { EventEmitter } from "node:events";
import { GuildQueue } from "../queue/index.js";
import { Mutex } from "../util/mutex.js";
import type { Semaphore } from "../util/semaphore.js";
import type { VoiceSession } from "../voice/session.js";
import type { AudioInfo, QueueItem, Requester, TrackMeta } from "../types/index.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import { DEFAULT_SETTINGS, applySettingsPatch, type GuildSettings } from "./settings.js";

interface DownloadResult {
  path: string;
  audio: AudioInfo | null;
}

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

/** Audio post-processing options handed to the resource factory for a single track. */
export interface AudioOptions {
  /** Pseudo-crossfade seconds (fade-out at end / fade-in at start). 0 = off. */
  crossfadeSec: number;
  /** Apply ffmpeg `loudnorm` (EBU R128) normalization. */
  normalizeLoudness: boolean;
}

export interface MakeResourceOpts {
  /** Start offset in ms; when > 0 the resource is produced by ffmpeg `-ss` (transcode, not Opus passthrough). */
  seekMs?: number;
  /** Per-track audio post-processing (loudnorm / pseudo-crossfade). Omitted = no processing. */
  audio?: AudioOptions;
}

export interface ControllerDeps {
  youtube: {
    download(videoId: string, outDir: string): Promise<DownloadResult>;
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
  /** Observability hook for AudioPlayer stream errors (logging only; recovery is via trackEnd). */
  onSessionError?: (err: unknown) => void;
  /** Called after any settings mutation so the host can persist (debounced) the change. */
  onSettingsChange?: (settings: GuildSettings) => void;
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

  // Playback-position tracking for the current track. `startedAt` is the epoch
  // ms the track began; `pausedAccumMs` is the total paused time so far; while
  // paused, `pausedAt` holds the moment the pause began.
  private startedAt: number | null = null;
  private pausedAccumMs = 0;
  private pausedAt: number | null = null;

  // Per-guild settings (idle timeout + crossfade/normalize/repeat), runtime-adjustable.
  // The idle timeout is the live source of truth; `idleTimeoutMs` derives from it.
  private _settings: GuildSettings;

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
   */
  updateSettings(patch: Partial<Record<keyof GuildSettings, unknown>>): GuildSettings {
    this._settings = applySettingsPatch(this._settings, patch);
    this.session?.setIdleTimeout(this.idleTimeoutMs);
    this.deps.onSettingsChange?.(this._settings);
    this.emit("changed");
    return { ...this._settings };
  }

  /** Audio post-processing options derived from current settings. */
  private audioOptions(): AudioOptions {
    return {
      crossfadeSec: this._settings.crossfadeSec,
      normalizeLoudness: this._settings.normalizeLoudness,
    };
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
    };
  }

  async restore(channelId: string, items: QueueItem[]): Promise<void> {
    await this.ensureConnected(channelId);
    for (const it of items) await this.queue.add(it.meta, it.requester);
    // maybeStart fires via the queue "changed" listener.
  }

  // Inline session create + listener wiring (shared by ensureConnected and moveTo; NOT locked itself).
  private async connectSessionLocked(channelId: string): Promise<void> {
    const session = await this.deps.createSession(channelId, this.idleTimeoutMs);
    session.on("trackEnd", () => {
      if (this.session === session) void this.playNext();
    });
    // A stream error always also drives the player Playing->Idle, which fires `trackEnd`
    // (see VoiceSession.onStateChange). Advancing here too would double-advance and skip a
    // track on every error. So we ONLY log/observe the error and let the single trackEnd
    // path advance exactly once.
    session.on("error", (err: unknown) => {
      if (this.session === session) this.deps.onSessionError?.(err);
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

  async enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
    // Per-guild max-track-length guard — the AUTHORITATIVE cap (panel-controlled),
    // superseding the global config. 0 = no limit; a null/unknown duration is always
    // allowed. Autoplay's best-effort feed (synthetic requester) bypasses this; it
    // enqueues via queue.add directly and should never be killed by the cap.
    const limit = this._settings.maxTrackDurationSec;
    if (
      requester.source !== "autoplay" &&
      limit > 0 &&
      meta.durationSec !== null &&
      meta.durationSec > limit
    ) {
      const hours = +(limit / 3600).toFixed(2);
      throw new YtError(
        YtErrorKind.TooLong,
        `Too long — max ${hours}h (track is ${meta.durationSec}s, over the ${limit}s limit)`,
      );
    }
    // A real user enqueue resets the autoplay chain budget: autoplay only kicks in once
    // the user-supplied queue has genuinely run dry, and should get a fresh cap then.
    if (requester.source !== "autoplay") this.autoplayChain = 0;
    const item = await this.queue.add(meta, requester);
    await this.maybeStart();
    return item;
  }

  skip(): void {
    this.session?.skip(); // emits trackEnd -> advance -> queue "changed" -> broadcast
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
      const wasPaused = this.pausedAt !== null;
      session.play(
        await this.deps.makeResource(path, current, {
          seekMs: positionMs,
          audio: this.audioOptions(),
        }),
      );
      // A fresh resource always starts playing; re-apply pause if we were paused.
      if (wasPaused) session.pause();
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
  async stop(): Promise<void> {
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
    this.session?.stop();
    // Stay in the voice channel after Stop; the normal idle timeout disconnects later.
    this.session?.startIdleTimer();
    this.emit("changed");
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

  // Plays a specific item in the current session WITHOUT advancing the queue. Returns false on failure.
  private async playItemLocked(item: QueueItem): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    try {
      const path = await this.ensureDownloaded(item.meta.videoId);
      // Defense-in-depth: ensureDownloaded yields, so a teardown (leaveInternal) could have
      // replaced/destroyed the session while we awaited. Never play onto a stale session or
      // pin against a cleared `pinned` set.
      if (this.session !== session) return false;
      item.audio = this.deps.cache.getAudio(item.meta.videoId);
      this.deps.cache.pin(item.meta.videoId);
      this.pinned.add(item.meta.videoId);
      session.play(await this.deps.makeResource(path, item, { audio: this.audioOptions() }));
      this.markTrackStarted();
      // Remember what just started so autoplay can seed its next pull from it (by id for
      // radio, by artist/channel for artist), and record the id so autoplay never
      // re-queues a track we've already played.
      this.lastPlayedMeta = item.meta;
      this.autoplaySeen.add(item.meta.videoId);
      // Re-broadcast now that the new track has actually started: the "changed"
      // fired from queue.advance() ran BEFORE markTrackStarted(), so the panel's
      // now-playing snapshot for this track still carried the PREVIOUS track's
      // elapsed position. Emit again so the panel gets the freshly-started track
      // with its position reset (no stale now-playing card after a skip/advance).
      this.emit("changed");
      return true;
    } catch (err) {
      this.deps.onTrackError?.({
        videoId: item.meta.videoId,
        title: item.meta.title,
        reason: err instanceof YtError ? err.kind : "download_failed",
      });
      return false;
    }
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
      item = await this.queue.advance();
    }
    // Nothing left in the queue. If autoplay is on, try to keep the music going with
    // YouTube's radio for the last track before falling back to idling.
    if (await this.tryAutoplayLocked()) return;
    session.startIdleTimer();
  }

  /**
   * Autoplay: when the queue is empty and `settings.autoplay` is on, fetch candidate
   * tracks for the last-played track and play the first NEW one (not already played/seen
   * this session). The SOURCE of the candidates depends on `settings.autoplaySource`:
   *   "radio"  → youtube.related(lastId)        — YouTube's Mix/radio for the last video.
   *   "artist" → youtube.artistTracks(lastMeta) — a search for the last track's artist.
   * Only the candidate fetch branches; the seen-id de-dup, the AUTOPLAY_MAX_CHAIN cap,
   * and the best-effort idle fallback are shared across both sources.
   *
   * HONESTY: neither source is a precise genre classifier or session-wide taste
   * matching — "radio" is YouTube's related feed, "artist" is a name-based search, both
   * keyed on the single last track.
   *
   * Best-effort: any failure (the source fetch throws, returns nothing new, or download
   * fails) resolves to `false`, letting the caller idle exactly as it does today.
   */
  private async tryAutoplayLocked(): Promise<boolean> {
    if (!this._settings.autoplay) return false;
    const seed = this.lastPlayedMeta;
    if (seed === null) return false;
    if (this.autoplayInFlight) return false;
    if (this.autoplayChain >= AUTOPLAY_MAX_CHAIN) return false;

    this.autoplayInFlight = true;
    try {
      let candidates: TrackMeta[];
      try {
        // Branch the SOURCE only; everything below is shared.
        candidates =
          this._settings.autoplaySource === "artist"
            ? await this.deps.youtube.artistTracks(seed)
            : await this.deps.youtube.related(seed.videoId);
      } catch {
        return false; // source lookup failed — fall back to idle
      }
      const next = candidates.find(
        (c) => c.videoId && !c.isLive && !this.autoplaySeen.has(c.videoId),
      );
      if (!next) return false;

      // Mark seen up-front so a play failure doesn't re-pick the same id on retry.
      this.autoplaySeen.add(next.videoId);
      this.autoplayChain += 1;
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

  private async ensureDownloaded(videoId: string): Promise<string> {
    const cached = this.deps.cache.get(videoId);
    if (cached) return cached;
    const { path, audio } = await this.deps.downloads.run(() =>
      this.deps.youtube.download(videoId, this.deps.cacheDir),
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
    this.session?.destroy();
    this.session = null;
    this.startedAt = null;
    this.pausedAt = null;
    this.pausedAccumMs = 0;
    for (const id of this.pinned) this.deps.cache.unpin(id);
    this.pinned.clear();
    // Forget the autoplay chain so a future session starts fresh.
    this.lastPlayedMeta = null;
    this.autoplaySeen.clear();
    this.autoplayChain = 0;
  }
}
