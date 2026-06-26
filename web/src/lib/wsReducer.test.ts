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
});
