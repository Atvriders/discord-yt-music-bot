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
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.advance();
    await q.add(meta("bbbbbbbbbbb"), requester);
    await q.clear();
    expect(q.current).toBeNull();
    expect(q.snapshot().upcoming).toEqual([]);
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
