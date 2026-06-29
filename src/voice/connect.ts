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
import type { VoiceBasedChannel } from "discord.js";
import { VoiceSession } from "./session.js";
import type { QueueItem } from "../types/index.js";
import type { AudioOptions } from "../orchestrator/index.js";
import { buildAudioFilter } from "./filter.js";
import { createLogger } from "../util/logger.js";

const log = createLogger().child({ mod: "voice/connect" });

export interface ResourceOpts {
  /** Start offset in ms; when > 0 the audio is produced by ffmpeg `-ss` (transcode, not Opus passthrough). */
  seekMs?: number;
  /** Per-track audio post-processing (loudnorm / pseudo-crossfade). Omitted = no processing. */
  audio?: AudioOptions;
}

/** Real connection: join + wait Ready (incl. DAVE handshake) + subscribe a player. */
export async function createVoiceSession(
  channel: VoiceBasedChannel,
  idleTimeoutMs: number,
): Promise<VoiceSession> {
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
  return new VoiceSession(connection as never, player as never, {
    channelId: channel.id,
    idleTimeoutMs,
  });
}

/**
 * Audio resource for the cached file.
 *
 * Fast path (offset 0, no audio post-processing): Opus-passthrough — probe the
 * container and pass the Opus stream straight through (ffmpeg only if non-Opus),
 * exactly as before.
 *
 * Transcoded path: required when EITHER a `seekMs` offset is requested (Opus frames
 * aren't randomly seekable) OR audio post-processing is enabled (loudnorm / the
 * pseudo-crossfade afade chain — see orchestrator/settings.ts CROSSFADE HONESTY). We
 * run ffmpeg with `-ss` and/or `-af`, emitting Opus in an Ogg container. The ffmpeg
 * spin-up is what produces the brief audible gap on scrub.
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
  if (seekMs > 0 || filter) {
    return createTranscodedResource(filePath, metadata, seekMs, filter);
  }
  const { stream, type } = await demuxProbe(createReadStream(filePath));
  return createAudioResource(stream, { inputType: type, inlineVolume: false, metadata });
}

/**
 * Transcode the cached file via ffmpeg, optionally seeking with `-ss` and/or applying
 * an `-af` audio-filter chain, producing an Ogg/Opus stream.
 */
function createTranscodedResource(
  filePath: string,
  metadata: unknown,
  seekMs: number,
  filter: string | null,
): AudioResource {
  const args = ["-loglevel", "error"];
  if (seekMs > 0) {
    args.push("-ss", (seekMs / 1000).toFixed(3)); // input seek: fast + accurate enough for scrubbing
  }
  args.push("-i", filePath, "-vn");
  if (filter) args.push("-af", filter);
  args.push("-c:a", "libopus", "-b:a", "128k", "-f", "ogg", "pipe:1");
  // Pipe (not ignore) stderr so transcode failures (bad filter, missing codec, corrupt
  // file, OOM) leave a trace instead of silently ending the stream → trackEnd. `-loglevel
  // error` already keeps the volume low, so buffering it is cheap.
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let errBuf = "";
  ff.stderr?.on("data", (c: Buffer) => {
    errBuf += c.toString();
  });
  ff.on("error", (err) => {
    log.error({ err, filter, filePath }, "ffmpeg spawn failed");
    ff.stdout.destroy();
  });
  ff.on("close", (code) => {
    if (code && code !== 0) {
      log.error({ code, filter, filePath, stderr: errBuf.slice(-2000) }, "ffmpeg transcode failed");
    }
  });
  const resource = createAudioResource(ff.stdout, {
    inputType: StreamType.OggOpus,
    inlineVolume: false,
    metadata,
  });
  // Reap ffmpeg when the consumer is done with the stream.
  ff.stdout.on("close", () => {
    if (ff.exitCode === null) ff.kill("SIGKILL");
  });
  return resource;
}
