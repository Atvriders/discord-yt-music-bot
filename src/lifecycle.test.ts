import { describe, it, expect, vi } from "vitest";
import { runShutdown } from "./lifecycle.js";

describe("runShutdown", () => {
  it("runs every task even if one throws, then resolves", async () => {
    const order: string[] = [];
    await runShutdown(
      [
        async () => {
          order.push("a");
        },
        async () => {
          throw new Error("b fails");
        },
        async () => {
          order.push("c");
        },
      ],
      { graceMs: 1000 },
    );
    expect(order).toEqual(["a", "c"]);
  });
  it("force-exits if a task hangs past graceMs", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      void runShutdown([() => new Promise(() => {})], { graceMs: 5, exitFn: exit });
      await vi.advanceTimersByTimeAsync(10);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
