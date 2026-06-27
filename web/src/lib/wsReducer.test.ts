import { describe, it, expect } from "vitest";
import { applyWsMessage, initialWsState } from "./useGuildState.js";

const snap = { current: null, upcoming: [], history: [] };

describe("applyWsMessage", () => {
  it("applies a state message and goes live", () => {
    const s = applyWsMessage(initialWsState, JSON.stringify({ type: "state", state: snap }));
    expect(s.status).toBe("live");
    expect(s.snapshot).toEqual(snap);
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
