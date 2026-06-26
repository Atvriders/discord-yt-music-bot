import pino, { type Logger } from "pino";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function createLogger(level = "info"): Logger {
  return pino({ level: LEVELS.has(level) ? level : "info", base: undefined });
}
