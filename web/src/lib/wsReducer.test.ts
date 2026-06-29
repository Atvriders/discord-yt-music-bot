import { describe, it, expect } from "vitest";
import { applyWsMessage, initialWsState } from "./useGuildState.js";
import type { Snapshot } from "../types.js";

// A fully-shaped Snapshot, annotated so the compiler flags any field added to or removed
// from the type — keeping the fixture in sync and making the round-trip assertion mean
// something for the new GuildSettings fields (crossfade/normalize/repeat/autoplay/...).
const snap: Snapshot = {
  current: null,
  upcoming: [],
  history: [],
  paused: false,
  idleTimeoutSec: 300,
  crossfadeSec: 0,
  normalizeLoudness: false,
  repeat: "off",
  autoplay: false,
  autoplaySource: "radio",
  maxTrackDurationSec: 0,
  volume: 100,
  fx: "none",
  preparing: null,
};

describe("applyWsMessage", () => {
  it("applies a state message and goes live", () => {
    const s = applyWsMessage(initialWsState, JSON.stringify({ type: "state", state: snap }));
    expect(s.status).toBe("live");
    expect(s.snapshot).toEqual(snap);
    // The new GuildSettings fields survive the reducer's pass-through.
    expect(s.snapshot?.repeat).toBe("off");
    expect(s.snapshot?.autoplaySource).toBe("radio");
    expect(s.receivedAt).toBeGreaterThan(0);
  });
  it("marks forbidden on an error message", () => {
    const s = applyWsMessage(initialWsState, JSON.stringify({ type: "error", reason: "forbidden" }));
    expect(s.status).toBe("forbidden");
  });
  it("marks forbidden on revoked", () => {
    expect(applyWsMessage(initialWsState, JSON.stringify({ type: "revoked" })).status).toBe("forbidden");
  });
  it("ignores malformed frames", () => {
    expect(applyWsMessage({ ...initialWsState, status: "live" }, "not json")).toMatchObject({ status: "live" });
  });
  it("sets lastError on a trackError frame and increments seq", () => {
    const s1 = applyWsMessage(initialWsState, JSON.stringify({ type: "trackError", title: "X", reason: "po_token_sabr" }));
    expect(s1.lastError).toMatchObject({ title: "X", reason: "po_token_sabr", seq: 1 });
    const s2 = applyWsMessage(s1, JSON.stringify({ type: "trackError", title: "Y", reason: "download_failed" }));
    expect(s2.lastError).toMatchObject({ title: "Y", reason: "download_failed", seq: 2 });
  });
});
