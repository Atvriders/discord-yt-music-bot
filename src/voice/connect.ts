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
  const { stream, type } = await demuxProbe(createReadStream(filePath));
  return createAudioResource(stream, { inputType: type, inlineVolume: false, metadata });
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
    inputType: inlineVolume ? StreamType.Raw : StreamType.OggOpus,
    inlineVolume,
    metadata,
  });
  // Reap ffmpeg when the consumer is done with the stream.
  ff.stdout.on("close", () => {
    if (ff.exitCode === null) ff.kill("SIGKILL");
  });
  return resource;
}
