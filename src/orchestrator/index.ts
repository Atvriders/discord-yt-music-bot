import { EventEmitter } from "node:events";
import { GuildQueue } from "../queue/index.js";
import { Mutex } from "../util/mutex.js";
import type { Semaphore } from "../util/semaphore.js";
import type { VoiceSession } from "../voice/session.js";
import type { AudioInfo, QueueItem, Requester, TrackMeta } from "../types/index.js";
import { YtError } from "../youtube/errors.js";
import { DEFAULT_SETTINGS, applySettingsPatch, type GuildSettings } from "./settings.js";

interface DownloadResult {
  path: string;
  audio: AudioInfo | null;
}

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
  youtube: { download(videoId: string, outDir: string): Promise<DownloadResult> };
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
}

export class GuildController extends EventEmitter {
  readonly queue: GuildQueue;
  private session: VoiceSession | null = null;
  private readonly lock = new Mutex();
  private readonly pinned = new Set<string>();
  private readonly now: () => number;

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
    session.on("error", () => {
      if (this.session === session) void this.playNext();
    });
    session.on("idle", () => {
      if (this.session === session) void this.leave();
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
      item.audio = this.deps.cache.getAudio(item.meta.videoId);
      this.deps.cache.pin(item.meta.videoId);
      this.pinned.add(item.meta.videoId);
      session.play(await this.deps.makeResource(path, item, { audio: this.audioOptions() }));
      this.markTrackStarted();
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
    session.startIdleTimer();
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
      this.deps.cache.pin(videoId);
      this.pinned.add(videoId);
    } catch {
      // prefetch is best-effort; a real failure surfaces when the track is played
    }
  }

  private async leave(): Promise<void> {
    this.session?.destroy();
    this.session = null;
    this.startedAt = null;
    this.pausedAt = null;
    this.pausedAccumMs = 0;
    for (const id of this.pinned) this.deps.cache.unpin(id);
    this.pinned.clear();
  }
}
