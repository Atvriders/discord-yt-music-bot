import { spawn } from "node:child_process";
import { YtError, YtErrorKind } from "./errors.js";

export interface YtDlpRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run yt-dlp, buffering stdout/stderr and resolving on close. The optional `onLine`
 * callback fires once per COMPLETE stdout line as it streams in (used to surface live
 * `[download] …` progress without waiting for the process to finish). Lines split across
 * read-chunk boundaries are reassembled; the trailing remainder (no terminating newline)
 * is flushed once on close so a final progress line is never lost. `onLine` is a pure
 * observer — it never affects the buffered `stdout` returned to the caller, and a throw
 * inside it is swallowed so a faulty observer can't break the download.
 */
export function runYtDlp(
  args: string[],
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<YtDlpRun> {
  return new Promise<YtDlpRun>((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Holds the partial trailing line between stdout chunks until its newline arrives.
    let lineBuf = "";
    const emitLine = (line: string): void => {
      if (!onLine) return;
      try {
        onLine(line);
      } catch {
        // A faulty observer must never break the download (best-effort progress).
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!onLine) return;
      lineBuf += chunk;
      let nl = lineBuf.indexOf("\n");
      while (nl !== -1) {
        // Strip a trailing \r so CRLF / yt-dlp \r-progress lines parse cleanly.
        emitLine(lineBuf.slice(0, nl).replace(/\r$/, ""));
        lineBuf = lineBuf.slice(nl + 1);
        nl = lineBuf.indexOf("\n");
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // Flush any final line that arrived without a trailing newline.
      if (lineBuf.length > 0) emitLine(lineBuf.replace(/\r$/, ""));
      if (timedOut) {
        reject(new YtError(YtErrorKind.Timeout, `yt-dlp timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}
