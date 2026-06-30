import { EventEmitter } from "node:events";
import type { QueueItem, Requester, TrackMeta } from "../types/index.js";
import { Mutex } from "../util/mutex.js";

export interface QueueSnapshot {
  current: QueueItem | null;
  upcoming: QueueItem[];
  history: QueueItem[];
}

export interface GuildQueueOptions {
  historyMax?: number;
  idFactory?: () => string;
  now?: () => number;
}

export class GuildQueue extends EventEmitter {
  private _current: QueueItem | null = null;
  private _upcoming: QueueItem[] = [];
  private _history: QueueItem[] = [];
  // UNCAPPED record of every track that has played (cleanly advanced) this cycle, kept
  // separately from the bounded `_history` ring so repeat="all" can re-cycle the FULL set even
  // when it exceeds historyMax. `_history` exists only for the display/Replay surface and is
  // capped; recycling off it would silently drop every track past historyMax on the 2nd lap.
  // Reset whenever the cycle is consumed (requeueHistory) or the queue is cleared.
  private _played: QueueItem[] = [];
  private readonly mutex = new Mutex();
  private readonly historyMax: number;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(opts: GuildQueueOptions = {}) {
    super();
    this.historyMax = opts.historyMax ?? 100;
    this.idFactory = opts.idFactory ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => Date.now());
  }

  get current(): QueueItem | null {
    return this._current;
  }

  snapshot(): QueueSnapshot {
    const clone = (i: QueueItem) => ({ ...i });
    return {
      current: this._current ? clone(this._current) : null,
      upcoming: this._upcoming.map(clone),
      history: this._history.map(clone),
    };
  }

  add(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
    return this.mutex.runExclusive(() => {
      const item: QueueItem = {
        id: this.idFactory(),
        meta,
        requester,
        addedAt: this.now(),
        audio: null,
      };
      this._upcoming.push(item);
      this.emitChange();
      return item;
    });
  }

  advance(): Promise<QueueItem | null> {
    return this.mutex.runExclusive(() => {
      if (this._current) {
        // Record into the UNCAPPED cycle buffer first (repeat=all replays the full set), then
        // into the bounded display history ring.
        this._played.push(this._current);
        this._history.push(this._current);
        if (this._history.length > this.historyMax) {
          this._history.splice(0, this._history.length - this.historyMax);
        }
      }
      this._current = this._upcoming.shift() ?? null;
      this.emitChange();
      return this._current;
    });
  }

  /**
   * Drop the current track WITHOUT archiving it to history, then promote the head of
   * upcoming to current. Used when a track FAILED to play (a player/resource error) rather
   * than finishing cleanly: a failed track never actually played, so recording it in
   * history (as a normal `advance()` would) is wrong — it would let "Replay" re-add a song
   * that just silently re-fails. Returns the newly-promoted current (or null when the queue
   * is empty). Distinct from `advance()`, which DOES history the finished track.
   */
  discardCurrent(): Promise<QueueItem | null> {
    return this.mutex.runExclusive(() => {
      this._current = this._upcoming.shift() ?? null;
      this.emitChange();
      return this._current;
    });
  }

  remove(itemId: string): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const idx = this._upcoming.findIndex((i) => i.id === itemId);
      if (idx === -1) return false;
      this._upcoming.splice(idx, 1);
      this.emitChange();
      return true;
    });
  }

  reorder(itemId: string, toIndex: number): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const from = this._upcoming.findIndex((i) => i.id === itemId);
      if (from === -1) return false;
      const clamped = Math.max(0, Math.min(toIndex, this._upcoming.length - 1));
      const [item] = this._upcoming.splice(from, 1);
      if (item) this._upcoming.splice(clamped, 0, item);
      this.emitChange();
      return true;
    });
  }

  /**
   * Shuffle the UPCOMING list in place with an unbiased Fisher-Yates pass, leaving the
   * current track and history untouched. `rng` defaults to Math.random; an injected RNG
   * makes the permutation deterministic for tests. Always emits "changed" (even for a
   * 0/1-item queue where the order can't change) so the panel re-renders consistently.
   */
  shuffle(rng: () => number = Math.random): Promise<void> {
    return this.mutex.runExclusive(() => {
      const u = this._upcoming;
      for (let i = u.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = u[i]!;
        u[i] = u[j]!;
        u[j] = tmp;
      }
      this.emitChange();
    });
  }

  /**
   * Repeat-all support: move the FULL set of tracks played this cycle (and the current track,
   * if any) back to the end of the upcoming list so the set replays in its original order.
   *
   * Recycles off the UNCAPPED `_played` buffer rather than the bounded `_history` ring, so a
   * playlist larger than historyMax replays in full on the next lap instead of silently losing
   * every track past the cap. Both the cycle buffer and the display history are cleared. No-op
   * when nothing has played. Returns the number requeued.
   */
  requeueHistory(): Promise<number> {
    return this.mutex.runExclusive(() => {
      const recycled = [...this._played];
      if (this._current) recycled.push(this._current);
      if (recycled.length === 0) return 0;
      this._played = [];
      this._history = [];
      this._current = null;
      this._upcoming.push(...recycled);
      this.emitChange();
      return recycled.length;
    });
  }

  clear(): Promise<void> {
    return this.mutex.runExclusive(() => {
      this._current = null;
      this._upcoming = [];
      // Stop ends the repeat-all cycle: drop the uncapped played buffer so a later repeat=all
      // requeue can't resurrect tracks from a session the user already stopped. (Display
      // `_history` is intentionally KEPT so the Replay surface survives a stop.)
      this._played = [];
      this.emitChange();
    });
  }

  private emitChange(): void {
    this.emit("changed", this.snapshot());
    // Optional-chain through `meta` too: a malformed head item (from a partial/torn snapshot
    // restore) must not crash the prefetch emit by reading .videoId off an undefined meta.
    this.emit("prefetch", this._upcoming[0]?.meta?.videoId ?? null);
  }
}
