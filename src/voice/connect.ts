import { createReadStream } from "node:fs";
import {
  joinVoiceChannel,
  entersState,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioResource,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import { VoiceSession } from "./session.js";

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

/** Opus passthrough resource (probe the container; ffmpeg only if non-Opus). */
export async function createPassthroughResource(
  filePath: string,
  metadata: unknown,
): Promise<AudioResource> {
  const { stream, type } = await demuxProbe(createReadStream(filePath));
  return createAudioResource(stream, { inputType: type, inlineVolume: false, metadata });
}
