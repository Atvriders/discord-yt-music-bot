import type { Logger } from "pino";

export interface ShutdownOpts {
  graceMs: number;
  exitFn?: (code: number) => void;
}
type Task = () => Promise<void> | void;

export async function runShutdown(tasks: Task[], opts: ShutdownOpts): Promise<void> {
  const exit = opts.exitFn ?? ((c) => process.exit(c));
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    exit(1);
  }, opts.graceMs);
  if (typeof timer.unref === "function") timer.unref();
  for (const task of tasks) {
    if (forced) return;
    try {
      await task();
    } catch {
      /* shutdown is best-effort */
    }
  }
  clearTimeout(timer);
}

export function installSignalHandlers(tasks: Task[], opts: ShutdownOpts, log?: Logger): void {
  let started = false;
  const handler = (sig: string) => {
    if (started) return;
    started = true;
    log?.info({ sig }, "shutting down");
    void runShutdown(tasks, opts).then(() => (opts.exitFn ?? ((c) => process.exit(c)))(0));
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

export function installCrashHandlers(log: Logger): void {
  process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandledRejection"));
  process.on("uncaughtException", (err) => log.error({ err }, "uncaughtException"));
}
