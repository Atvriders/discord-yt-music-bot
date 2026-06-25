import { spawn } from "node:child_process";
import { YtError, YtErrorKind } from "./errors.js";

export interface YtDlpRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runYtDlp(args: string[], timeoutMs: number): Promise<YtDlpRun> {
  return new Promise<YtDlpRun>((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new YtError(YtErrorKind.Timeout, `yt-dlp timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}
