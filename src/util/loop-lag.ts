import { monitorEventLoopDelay } from "node:perf_hooks";
import { getRootLogger } from "./logger.js";

/**
 * Event-loop stall detector.
 *
 * Audio is pumped from this process's event loop: @discordjs/voice sends an Opus frame every
 * 20 ms, so ANY synchronous work that blocks the loop for longer than that is audible, and a
 * block of seconds is a freeze. When playback stutters the first question is always "was the
 * loop blocked, or was it the network?", and without this there is no way to tell them apart
 * from the outside — the two look identical to a listener.
 *
 * `monitorEventLoopDelay` is a libuv-level histogram: it costs effectively nothing to keep
 * running, and unlike a setInterval-drift probe it cannot itself be starved by the very block
 * it is trying to measure.
 */

/** Blocks longer than this are worth naming: several audio frames have already been missed. */
const STALL_WARN_MS = 250;
/** How often the histogram is examined and reset. */
const SAMPLE_MS = 10_000;

export interface LoopLagMonitor {
  stop(): void;
}

export function startLoopLagMonitor(
  opts: { warnMs?: number; sampleMs?: number } = {},
): LoopLagMonitor {
  const warnMs = opts.warnMs ?? STALL_WARN_MS;
  const sampleMs = opts.sampleMs ?? SAMPLE_MS;
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const timer = setInterval(() => {
    const maxMs = h.max / 1e6;
    const p99Ms = h.percentile(99) / 1e6;
    h.reset();
    if (maxMs < warnMs) return;
    getRootLogger()
      .child({ mod: "util/loop-lag" })
      .warn(
        { maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms), windowMs: sampleMs },
        "event loop was BLOCKED — audio is pumped from this loop, so a stall here is a stall in the music",
      );
  }, sampleMs);
  // Never hold the process open just to report on it.
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
      h.disable();
    },
  };
}
