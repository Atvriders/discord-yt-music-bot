import { EventEmitter } from "node:events";
import { GuildQueue } from "../queue/index.js";
import { Mutex } from "../util/mutex.js";
import type { Semaphore } from "../util/semaphore.js";
import type { VoiceSession } from "../voice/session.js";
import type { QueueItem, Requester, TrackMeta } from "../types/index.js";
import { YtError } from "../youtube/errors.js";

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
  // The factory receives the controller's current idle timeout so freshly-created
  // sessions honor the runtime (per-guild) value, not just the static default.
  createSession: (channelId: string, idleTimeoutMs: number) => Promise<VoiceSession>;
  makeResource: (filePath: string, item: QueueItem) => unknown | Promise<unknown>;
  prefetchDepth: number;
  /** Initial idle-disconnect timeout (ms); the panel can override it per guild at runtime. */
  idleTimeoutMs: number;
  downloads: Semaphore;
  queue?: GuildQueue;
  now?: () => number;
  onTrackError?: (info: { videoId: string; title: string; reason: string }) => void;
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

  // Runtime-adjustable idle-disconnect timeout (ms), seeded from the configured default.
  private idleTimeoutMs: number;

  constructor(
    readonly guildId: string,
    private readonly deps: ControllerDeps,
  ) {
    super();
    this.idleTimeoutMs = deps.idleTimeoutMs;
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

  /** Current idle-disconnect timeout in seconds (per-guild, runtime-adjustable). */
  getIdleTimeoutSec(): number {
    return Math.round(this.idleTimeoutMs / 1000);
  }

  /**
   * Set the idle-disconnect timeout (seconds). Updates the value used for new
   * sessions, applies it immediately to the live session (restarting a running
   * idle timer), and emits "changed" so the panel reflects it live.
   */
  setIdleTimeoutSec(sec: number): void {
    this.idleTimeoutMs = sec * 1000;
    this.session?.setIdleTimeout(this.idleTimeoutMs);
    this.emit("changed");
  }

  /** Elapsed ms of the current track, excluding paused time. */
  private positionMs(): number {
    if (this.startedAt === null) return 0;
    const pausedNow = this.pausedAt !== null ? this.now() - this.pausedAt : 0;
    const elapsed = this.now() - this.startedAt - this.pausedAccumMs - pausedNow;
    return Math.max(0, elapsed);
  }

  // Reset position tracking the moment a new track starts playing.
  private markTrackStarted(): void {
    this.startedAt = this.now();
    this.pausedAccumMs = 0;
    this.pausedAt = null;
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
      idleTimeoutSec: this.getIdleTimeoutSec(),
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
      this.deps.cache.pin(item.meta.videoId);
      this.pinned.add(item.meta.videoId);
      session.play(await this.deps.makeResource(path, item));
      this.markTrackStarted();
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
    this.startedAt = null;
    this.pausedAt = null;
    this.pausedAccumMs = 0;
    for (const id of this.pinned) this.deps.cache.unpin(id);
    this.pinned.clear();
  }
}
