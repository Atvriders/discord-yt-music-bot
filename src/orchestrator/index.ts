import { GuildQueue } from "../queue/index.js";
import { Mutex } from "../util/mutex.js";
import type { Semaphore } from "../util/semaphore.js";
import type { VoiceSession } from "../voice/session.js";
import type { QueueItem, Requester, TrackMeta } from "../types/index.js";

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
  createSession: (channelId: string) => Promise<VoiceSession>;
  makeResource: (filePath: string, item: QueueItem) => unknown | Promise<unknown>;
  prefetchDepth: number;
  downloads: Semaphore;
  queue?: GuildQueue;
}

export class GuildController {
  readonly queue: GuildQueue;
  private session: VoiceSession | null = null;
  private readonly lock = new Mutex();
  private readonly pinned = new Set<string>();

  constructor(
    readonly guildId: string,
    private readonly deps: ControllerDeps,
  ) {
    this.queue = deps.queue ?? new GuildQueue();
    this.queue.on("prefetch", (videoId: string | null) => {
      if (videoId) void this.prefetch(videoId);
    });
    this.queue.on("changed", () => {
      void this.maybeStart();
    });
  }

  snapshot() {
    return this.queue.snapshot();
  }

  async ensureConnected(channelId: string): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (this.session) return;
      const session = await this.deps.createSession(channelId);
      session.on("trackEnd", () => void this.playNext());
      session.on("error", () => void this.playNext()); // skip the broken track
      session.on("idle", () => void this.leave());
      this.session = session;
    });
  }

  async enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
    const item = await this.queue.add(meta, requester);
    await this.maybeStart();
    return item;
  }

  skip(): void {
    this.session?.skip();
  }
  pause(): void {
    this.session?.pause();
  }
  resume(): void {
    this.session?.resume();
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
    await this.leave();
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

  private async playNextLocked(): Promise<void> {
    const session = this.session;
    if (!session) return;
    let item = await this.queue.advance();
    while (item) {
      try {
        const path = await this.ensureDownloaded(item.meta.videoId);
        this.deps.cache.pin(item.meta.videoId);
        this.pinned.add(item.meta.videoId);
        session.play(await this.deps.makeResource(path, item));
        return;
      } catch {
        // download/playback failed for this track — skip it and try the next
        item = await this.queue.advance();
      }
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
    for (const id of this.pinned) this.deps.cache.unpin(id);
    this.pinned.clear();
  }
}
