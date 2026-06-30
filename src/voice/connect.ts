import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import {
  joinVoiceChannel,
  entersState,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioResource,
} from "@discordjs/voice";
import { PermissionsBitField, type VoiceBasedChannel } from "discord.js";
import { VoiceSession } from "./session.js";
import type { QueueItem } from "../types/index.js";
import type { AudioOptions } from "../orchestrator/index.js";
import { buildAudioFilter } from "./filter.js";
import { getRootLogger } from "../util/logger.js";

// Use the process-wide root logger (configured from LOG_LEVEL in main()) rather than an
// independent hardcoded-"info" instance, so these logs actually follow LOG_LEVEL. Resolved
// lazily per log call so it picks up setRootLogger() regardless of module-load order.
const log = {
  warn: (obj: object, msg: string): void =>
    void getRootLogger().child({ mod: "voice/connect" }).warn(obj, msg),
  error: (obj: object, msg: string): void =>
    void getRootLogger().child({ mod: "voice/connect" }).error(obj, msg),
};

export interface ResourceOpts {
  /** Start offset in ms; when > 0 the audio is produced by ffmpeg `-ss` (transcode, not Opus passthrough). */
  seekMs?: number;
  /** Per-track audio post-processing (loudnorm / pseudo-crossfade). Omitted = no processing. */
  audio?: AudioOptions;
}

/**
 * Thrown when the bot lacks the Connect/Speak/ViewChannel permission on the target voice
 * channel. Distinct from a generic connect failure so callers can surface a clear,
 * actionable message ("I don't have permission to speak in #channel") instead of letting the
 * user wait out the full 30s entersState(Ready) timeout that a permission denial would cause.
 */
export class VoicePermissionError extends Error {
  constructor(public readonly channelId: string) {
    super(`Missing Connect/Speak permission in channel ${channelId}`);
    this.name = "VoicePermissionError";
  }
}

/** Real connection: join + wait Ready (incl. DAVE handshake) + subscribe a player. */
export async function createVoiceSession(
  channel: VoiceBasedChannel,
  idleTimeoutMs: number,
): Promise<VoiceSession> {
  // Pre-flight permission check: without Connect/Speak (and ViewChannel) joinVoiceChannel still
  // "joins" but entersState(Ready) times out after a full 30s (or connects muted to no one).
  // Fail FAST with a distinct error instead of making the user wait out that hang.
  const me = channel.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (
    perms &&
    !perms.has(
      [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
      ],
      true,
    )
  ) {
    throw new VoicePermissionError(channel.id);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    connection.destroy();
    throw err;
  }
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  const session = new VoiceSession(connection as never, player as never, {
    channelId: channel.id,
    idleTimeoutMs,
  });

  // The VoiceConnection is an EventEmitter that emits "error" (UDP / VoiceWebSocket /
  // Networking failures). Nothing else attaches a connection "error" listener, and Node throws
  // when an "error" is emitted with zero listeners — a whole-process crash vector. Attach one
  // here so the event can never go unhandled, then tear the session down via the controller's
  // normal idle path.
  connection.on("error", (err: unknown) => {
    log.error({ err, channelId: channel.id }, "voice connection error");
    session.signalConnectionLost();
  });

  // @discordjs/voice does NOT auto-recover a Disconnected connection by default. The documented
  // pattern is to race entersState(Signalling|Connecting, ~5s): if either resolves the library
  // is mid-reconnect (a server move / brief blip) — ride it out. If neither resolves (a 4014
  // kick / fatal adapter failure) destroy the connection and tear the session down cleanly so
  // playback doesn't hang forever with the idle timer cancelled.
  connection.on("stateChange", (_old: unknown, next: { status: string }) => {
    if (next.status !== VoiceConnectionStatus.Disconnected) return;
    void (async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Reconnect in progress — let the library finish.
      } catch {
        // Unrecoverable: drop the dead connection and tear the session down via the idle path.
        try {
          connection.destroy();
        } catch {
          // already destroyed
        }
        session.signalConnectionLost();
      }
    })();
  });

  return session;
}

/**
 * Audio resource for the cached file.
 *
 * Fast path (offset 0, no audio post-processing, volume 100): Opus-passthrough — probe
 * the container and pass the Opus stream straight through (ffmpeg only if non-Opus),
 * exactly as before.
 *
 * Transcoded path: required when ANY of:
 *   - a `seekMs` offset is requested (Opus frames aren't randomly seekable);
 *   - audio post-processing is enabled (loudnorm / the pseudo-crossfade afade chain /
 *     an FX preset — see orchestrator/settings.ts);
 *   - the volume is not 100 % — inline volume needs raw PCM, so we can't passthrough Opus.
 * We run ffmpeg with `-ss` and/or `-af`, emitting Opus in an Ogg container. The ffmpeg
 * spin-up is what produces the brief audible gap on scrub.
 *
 * INLINE VOLUME: when a non-100 volume is requested the resource is created with
 * `{ inlineVolume: true }` so the controller can `resource.volume.setVolume(v/100)` on
 * play and live thereafter. Inline volume forces PCM decoding (no Opus passthrough),
 * which is exactly why a non-100 volume drops out of the fast path.
 */
export async function createPassthroughResource(
  filePath: string,
  metadata: unknown,
  opts: ResourceOpts = {},
): Promise<AudioResource> {
  const seekMs = opts.seekMs ?? 0;
  const item = metadata as Partial<QueueItem> | undefined;
  const filter = opts.audio
    ? buildAudioFilter(
        opts.audio,
        item?.meta?.durationSec ?? null,
        item?.meta?.isLive ?? false,
        seekMs,
      )
    : null;
  const volumePct = opts.audio?.volumePct ?? 100;
  // Inline volume is enabled whenever volume != 100. It requires PCM (no Opus
  // passthrough), so it also forces the transcoded path.
  const inlineVolume = volumePct !== 100;
  if (seekMs > 0 || filter || inlineVolume) {
    return createTranscodedResource(filePath, metadata, seekMs, filter, inlineVolume);
  }
  // FAST PATH: probe the container and pass the Opus stream straight through. demuxProbe
  // only classifies Ogg/Opus and WebM/Opus — a downloaded file in any OTHER container
  // (e.g. m4a/AAC when YouTube served no opus format, or anything demuxProbe can't
  // classify) makes the probe throw. Before, that propagated as a resource that errored on
  // play → the track was silently skipped. Fall back to an ffmpeg transcode (→ Ogg/Opus)
  // so the track still plays instead of failing the format check.
  try {
    const { stream, type } = await demuxProbe(createReadStream(filePath));
    return createAudioResource(stream, { inputType: type, inlineVolume: false, metadata });
  } catch (err) {
    log.warn({ err, filePath }, "demuxProbe failed; falling back to ffmpeg transcode");
    return createTranscodedResource(filePath, metadata, 0, null, false);
  }
}

/**
 * Transcode the cached file via ffmpeg, optionally seeking with `-ss` and/or applying
 * an `-af` audio-filter chain.
 *
 * Output format depends on whether INLINE VOLUME is requested:
 *   - inlineVolume=false → Ogg/Opus (cheap, @discordjs/voice passes it through).
 *   - inlineVolume=true  → raw signed-16-bit-LE stereo 48k PCM (StreamType.Raw) so the
 *     resource's volume transformer can scale samples directly; @discordjs/voice then
 *     encodes to Opus. This is the PCM path inline volume requires.
 */
function createTranscodedResource(
  filePath: string,
  metadata: unknown,
  seekMs: number,
  filter: string | null,
  inlineVolume = false,
): AudioResource {
  const args = ["-loglevel", "error"];
  if (seekMs > 0) {
    args.push("-ss", (seekMs / 1000).toFixed(3)); // input seek: fast + accurate enough for scrubbing
  }
  args.push("-i", filePath, "-vn");
  if (filter) args.push("-af", filter);
  if (inlineVolume) {
    // Raw PCM for the volume transformer: s16le, stereo, 48 kHz (Discord's native rate).
    args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");
  } else {
    args.push("-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "pipe:1");
  }
  // Pipe (not ignore) stderr so transcode failures (bad filter, missing codec, corrupt
  // file, OOM) leave a trace instead of silently ending the stream → trackEnd. `-loglevel
  // error` already keeps the volume low, so buffering it is cheap.
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let errBuf = "";
  // Set right before any intentional SIGKILL (watchdog reap / stdout-close reap) so the
  // 'close' handler can tell a deliberate reap (no log wanted) from a genuine abnormal exit —
  // including an OOM SIGKILL, which we DO want logged. Distinguishing on the signal name alone
  // can't separate our SIGKILL from the OOM-killer's, so we track intent explicitly.
  let reaped = false;
  // Watchdog: SIGKILL the child if its stdout is never consumed within this window. Covers
  // the case where the resource is built but the consumer never attaches — e.g. the session
  // is torn down right after handoff, or @discordjs/voice swaps the resource without closing
  // the underlying readable — leaving the child alive holding the input file open. We detect
  // "consumption started" via the 'resume' event (fired when a reader puts the stream into
  // flowing mode) rather than 'data', so we never drain bytes out from under the real audio
  // consumer. Once consumption starts, normal 'close'/'exit'/'error' reaping takes over.
  const FF_UNCONSUMED_TIMEOUT_MS = 60_000;
  let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    watchdog = null;
    if (ff.exitCode === null) {
      log.warn({ filter, filePath }, "ffmpeg output never consumed; killing orphaned child");
      reaped = true;
      ff.kill("SIGKILL");
    }
  }, FF_UNCONSUMED_TIMEOUT_MS);
  // Don't let the watchdog keep the event loop (or a test run) alive on its own.
  watchdog.unref?.();
  const clearWatchdog = (): void => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };
  ff.stderr?.on("data", (c: Buffer) => {
    errBuf += c.toString();
  });
  // Consumer attached and pulling: the stream is healthy, so the normal close/exit reaper
  // covers teardown. 'resume' does not consume bytes (unlike a 'data' listener).
  ff.stdout.once("resume", clearWatchdog);
  ff.on("error", (err) => {
    log.error({ err, filter, filePath }, "ffmpeg spawn failed");
    clearWatchdog();
    ff.stdout.destroy();
  });
  // 'exit' fires once the process is gone regardless of how stdio closes; clear the
  // watchdog and drop the (potentially large) stderr buffer so it can be GC'd.
  ff.on("exit", () => {
    clearWatchdog();
  });
  ff.on("close", (code, signal) => {
    // Log any genuinely abnormal exit — a non-zero code OR a terminating signal (SIGSEGV from
    // a corrupt file, SIGPIPE, an OOM SIGKILL) — but stay silent on a deliberate reap. Reading
    // only `code` (as before) missed signal-terminated crashes entirely (code is null then).
    if (!reaped && ((code !== null && code !== 0) || signal)) {
      log.error(
        { code, signal, filter, filePath, stderr: errBuf.slice(-2000) },
        "ffmpeg transcode failed",
      );
    }
    errBuf = "";
  });
  const resource = createAudioResource(ff.stdout, {
    inputType: inlineVolume ? StreamType.Raw : StreamType.OggOpus,
    inlineVolume,
    metadata,
  });
  // Reap ffmpeg when the consumer is done with the stream.
  ff.stdout.on("close", () => {
    clearWatchdog();
    if (ff.exitCode === null) {
      reaped = true;
      ff.kill("SIGKILL");
    }
  });
  return resource;
}
