import { describe, it, expect, vi } from "vitest";
import { GuildQueue } from "./index.js";
import type { Requester, TrackMeta } from "../types/index.js";

const requester: Requester = {
  discordUserId: "1",
  displayName: "u",
  avatarUrl: "http://a",
  source: "discord",
};
function meta(videoId: string): TrackMeta {
  return {
    videoId,
    title: videoId,
    channel: "c",
    durationSec: 100,
    isLive: false,
    thumbnailUrl: null,
  };
}
function newQueue() {
  let n = 0;
  return new GuildQueue({ historyMax: 2, idFactory: () => `id${++n}`, now: () => 0 });
}

describe("GuildQueue", () => {
  it("adds to upcoming and emits changed + prefetch", async () => {
    const q = newQueue();
    const changed = vi.fn();
    const prefetch = vi.fn();
    q.on("changed", changed);
    q.on("prefetch", prefetch);

    const item = await q.add(meta("aaaaaaaaaaa"), requester);
    expect(item.id).toBe("id1");
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1"]);
    expect(q.current).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenLastCalledWith("aaaaaaaaaaa");
  });

  it("advance() promotes the head and moves the old current to history", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);

    const first = await q.advance();
    expect(first?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(q.current?.meta.videoId).toBe("aaaaaaaaaaa");

    const second = await q.advance();
    expect(second?.meta.videoId).toBe("bbbbbbbbbbb");
    expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["aaaaaaaaaaa"]);

    const none = await q.advance();
    expect(none).toBeNull();
    expect(q.current).toBeNull();
  });

  it("bounds history to historyMax (ring buffer)", async () => {
    const q = newQueue(); // historyMax 2
    for (const v of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]) {
      await q.add(meta(v), requester);
    }
    await q.advance();
    await q.advance();
    await q.advance();
    await q.advance(); // 3 items have rolled into history, capped at 2
    expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("removes an upcoming item by id", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    const b = await q.add(meta("bbbbbbbbbbb"), requester);
    expect(await q.remove(b.id)).toBe(true);
    expect(await q.remove("nope")).toBe(false);
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1"]);
  });

  it("reorders an upcoming item to a new index", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    const c = await q.add(meta("ccccccccccc"), requester);
    expect(await q.reorder(c.id, 0)).toBe(true);
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
      "ccccccccccc",
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
    ]);
  });

  it("clear() empties current and upcoming but keeps history", async () => {
    const q = newQueue();
    // Two advances so a track actually lands in history (clear() does NOT archive the
    // current track, so a single advance would leave history empty and the assertion vacuous).
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    await q.advance(); // current = A
    await q.advance(); // current = B, history = [A]
    await q.add(meta("ccccccccccc"), requester); // upcoming = [C]
    await q.clear();
    expect(q.current).toBeNull();
    expect(q.snapshot().upcoming).toEqual([]);
    // History must survive clear(); a regression that wiped _history would fail here.
    expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["aaaaaaaaaaa"]);
  });

  it("requeueHistory cycles played history + current back to the end of upcoming", async () => {
    // historyMax is 2 in this helper, so use two played tracks to stay within it.
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester); // id1
    await q.add(meta("bbbbbbbbbbb"), requester); // id2
    await q.advance(); // current = id1
    await q.advance(); // current = id2, history = [id1]
    expect(q.snapshot().upcoming).toEqual([]);

    const n = await q.requeueHistory();
    expect(n).toBe(2); // history (id1) + current (id2)
    expect(q.current).toBeNull();
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1", "id2"]);
    expect(q.snapshot().history).toEqual([]);
  });

  it("requeueHistory is a no-op when nothing has played", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    const n = await q.requeueHistory();
    expect(n).toBe(0);
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1"]);
  });

  it("shuffle permutes the upcoming items while preserving the exact set", async () => {
    const q = newQueue();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const it = await q.add(meta(`v${String(i).padStart(10, "0")}`), requester);
      ids.push(it.id);
    }
    const before = q.snapshot().upcoming.map((i) => i.id);
    // Deterministic RNG: 0 picks index 0 on every Fisher-Yates step, yielding a known
    // non-identity permutation (a cascade of swaps with the head) so we can assert the
    // order actually changed.
    const changed = vi.fn();
    q.on("changed", changed);
    await q.shuffle(() => 0);
    const after = q.snapshot().upcoming.map((i) => i.id);
    // Same multiset of ids (nothing lost/added/duplicated).
    expect([...after].sort()).toEqual([...before].sort());
    // Order actually permuted (not the identity).
    expect(after).not.toEqual(before);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shuffle leaves current/history untouched and is a no-op (still emits) on a short queue", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.advance(); // current = id1, upcoming empty
    const b = await q.add(meta("bbbbbbbbbbb"), requester); // upcoming = [id2]
    const changed = vi.fn();
    q.on("changed", changed);
    await q.shuffle();
    expect(q.current?.id).toBe("id1");
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual([b.id]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shuffle defaults to Math.random and keeps the set intact", async () => {
    const q = newQueue();
    const created: string[] = [];
    for (const v of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]) {
      created.push((await q.add(meta(v), requester)).id);
    }
    await q.shuffle();
    expect([...q.snapshot().upcoming.map((i) => i.id)].sort()).toEqual([...created].sort());
  });

  it("serializes concurrent adds without losing or duplicating items", async () => {
    const q = newQueue();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        q.add(meta(`v${String(i).padStart(10, "0")}`), requester),
      ),
    );
    const ids = q.snapshot().upcoming.map((i) => i.id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50); // all unique, none lost
  });
});
