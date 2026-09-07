import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startLoopLagMonitor } from "./loop-lag.js";
import { createLogger, setRootLogger } from "./logger.js";

/**
 * The monitor exists to answer one question after a freeze: was the event loop blocked?
 * Audio leaves this process one Opus frame per 20 ms, so a synchronous block is audible —
 * and it is otherwise indistinguishable from a network problem.
 */

let warnings: { obj: unknown; msg: string }[] = [];

beforeEach(() => {
  warnings = [];
  const logger = createLogger("silent");
  // pino's child() returns a logger; stub the whole chain so the assertion sees the call.
  const fake = {
    child: () => fake,
    warn: (obj: unknown, msg: string) => warnings.push({ obj, msg }),
  };
  setRootLogger(fake as never);
  vi.useFakeTimers();
  void logger;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startLoopLagMonitor", () => {
  it("stays quiet when the loop is healthy", () => {
    const m = startLoopLagMonitor({ warnMs: 100_000, sampleMs: 50 });
    vi.advanceTimersByTime(200);
    m.stop();
    expect(warnings).toHaveLength(0);
  });

  it("reports a block that would have been audible", () => {
    // Threshold at 0 so any measured delay trips it — the histogram always records SOMETHING,
    // and what is under test is the reporting path, not libuv's timing.
    const m = startLoopLagMonitor({ warnMs: 0, sampleMs: 10 });
    vi.advanceTimersByTime(30);
    m.stop();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.msg).toMatch(/event loop was BLOCKED/);
    expect(warnings[0]!.obj).toMatchObject({ maxMs: expect.any(Number) });
  });

  it("stops reporting once stopped", () => {
    const m = startLoopLagMonitor({ warnMs: 0, sampleMs: 10 });
    vi.advanceTimersByTime(30);
    const seen = warnings.length;
    m.stop();
    vi.advanceTimersByTime(100);
    expect(warnings).toHaveLength(seen);
  });
});
