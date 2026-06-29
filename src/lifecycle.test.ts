import { describe, it, expect, vi, afterEach } from "vitest";
import { runShutdown, installSignalHandlers, installCrashHandlers } from "./lifecycle.js";

describe("runShutdown", () => {
  it("runs every task even if one throws, then resolves true", async () => {
    const order: string[] = [];
    const ok = await runShutdown(
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
    expect(ok).toBe(true);
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
  it("skips remaining tasks after the grace timer forces exit", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const second = vi.fn(async () => {});
      // First task resolves only AFTER the grace timer fires, so the loop advances to
      // the next iteration where the `if (forced) return false` guard short-circuits.
      const p = runShutdown([() => new Promise<void>((res) => setTimeout(res, 8)), second], {
        graceMs: 5,
        exitFn: exit,
      });
      await vi.advanceTimersByTimeAsync(6); // grace timer fires -> forced=true, exit(1)
      await vi.advanceTimersByTimeAsync(3); // first task resolves -> loop sees forced
      expect(await p).toBe(false);
      expect(exit).toHaveBeenCalledWith(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installSignalHandlers", () => {
  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("exits with code 0 after a clean graceful shutdown on SIGTERM", async () => {
    const exit = vi.fn();
    const task = vi.fn(async () => {});
    installSignalHandlers([task], { graceMs: 1000, exitFn: exit });
    process.emit("SIGTERM");
    // flush the runShutdown microtasks
    await new Promise((r) => setImmediate(r));
    expect(task).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second signal (started idempotency guard)", async () => {
    const exit = vi.fn();
    const task = vi.fn(async () => {});
    installSignalHandlers([task], { graceMs: 1000, exitFn: exit });
    process.emit("SIGTERM");
    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    expect(task).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not exit(0) when the shutdown is force-exited", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      installSignalHandlers([() => new Promise(() => {})], { graceMs: 5, exitFn: exit });
      process.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(10);
      expect(exit).toHaveBeenCalledWith(1);
      expect(exit).not.toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installCrashHandlers", () => {
  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
  });

  it("logs an unhandledRejection without exiting", () => {
    const log = { error: vi.fn() } as never;
    const exit = vi.fn();
    installCrashHandlers(log, exit);
    process.emit("unhandledRejection", new Error("nope"), Promise.resolve());
    expect((log as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs an uncaughtException and exits with code 1", async () => {
    const log = { error: vi.fn() } as never;
    const exit = vi.fn();
    installCrashHandlers(log, exit);
    process.emit("uncaughtException", new Error("boom"));
    expect((log as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
    // exit is deferred by one tick (setImmediate) so the log transport can flush.
    expect(exit).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
