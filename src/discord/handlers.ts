import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import type { Command } from "./command-parser.js";
import { parseInput } from "../youtube/url-parser.js";
import { buildPicker } from "./picker.js";
import { selectVoiceChannel } from "../orchestrator/voice-selection.js";
import { YtError } from "../youtube/errors.js";
import type { GuildController } from "../orchestrator/index.js";
import type { Requester, TrackMeta } from "../types/index.js";

export interface HandlerContext {
  controller: Pick<
    GuildController,
    | "ensureConnected"
    | "moveTo"
    | "enqueue"
    | "skip"
    | "pause"
    | "resume"
    | "stop"
    | "remove"
    | "snapshot"
  >;
  youtube: {
    resolve(videoId: string): Promise<TrackMeta>;
    search(query: string, limit: number): Promise<TrackMeta[]>;
  };
  requester: Requester;
  requesterChannelId: string | null;
  botChannelId: string | null;
  isAdmin: boolean;
  searchLimit: number;
}

export type HandlerResult =
  | { type: "message"; content: string }
  | { type: "picker"; content: string; components: ActionRowBuilder<ButtonBuilder>[] };

const HELP = [
  "**Commands**",
  "`?play <youtube-url | search terms>` — queue a link, or search and pick",
  "`?skip` `?pause` `?resume` `?stop` — playback control",
  "`?queue` `?np` — show the queue / now playing",
  "`?remove <n>` — remove queue item n",
].join("\n");

function msg(content: string): HandlerResult {
  return { type: "message", content };
}

export async function handleCommand(cmd: Command, ctx: HandlerContext): Promise<HandlerResult> {
  switch (cmd.kind) {
    case "play":
      return handlePlay(cmd.input, ctx);
    case "skip":
      ctx.controller.skip();
      return msg("⏭️ Skipped.");
    case "pause":
      ctx.controller.pause();
      return msg("⏸️ Paused.");
    case "resume":
      ctx.controller.resume();
      return msg("▶️ Resumed.");
    case "stop":
      await ctx.controller.stop();
      return msg("⏹️ Stopped and cleared the queue.");
    case "remove":
      return handleRemove(cmd.index, ctx);
    case "queue":
      return msg(formatQueue(ctx));
    case "np":
      return msg(formatNowPlaying(ctx));
    case "help":
    case "none": // filtered upstream; defensive fallthrough to help
      return msg(HELP);
  }
}

async function handlePlay(input: string, ctx: HandlerContext): Promise<HandlerResult> {
  const parsed = parseInput(input);
  if (parsed.kind === "reject") return msg(`❌ ${parsed.reason}`);

  if (parsed.kind === "query") {
    const results = await ctx.youtube.search(parsed.query, ctx.searchLimit);
    if (results.length === 0) return msg("No results.");
    const picker = buildPicker(results);
    return { type: "picker", content: picker.content, components: picker.components };
  }

  // exact video
  let meta: TrackMeta;
  try {
    meta = await ctx.youtube.resolve(parsed.videoId);
  } catch (err) {
    return msg(
      err instanceof YtError
        ? `❌ Can't play that (${err.kind}).`
        : "❌ Failed to load that video.",
    );
  }
  const target = selectVoiceChannel({
    requesterChannelId: ctx.requesterChannelId,
    botChannelId: ctx.botChannelId,
    isAdmin: ctx.isAdmin,
  });
  if (!target.ok) return msg(`❌ ${target.reason}`);
  if (target.move) await ctx.controller.moveTo(target.channelId);
  else await ctx.controller.ensureConnected(target.channelId);
  await ctx.controller.enqueue(meta, ctx.requester);
  return msg(`➕ Queued **${meta.title}**.`);
}

async function handleRemove(index: number, ctx: HandlerContext): Promise<HandlerResult> {
  const upcoming = ctx.controller.snapshot().upcoming;
  const item = upcoming[index - 1];
  if (!item) return msg(`No queue item #${index}.`);
  await ctx.controller.remove(item.id);
  return msg(`🗑️ Removed **${item.meta.title}**.`);
}

function formatNowPlaying(ctx: HandlerContext): string {
  const cur = ctx.controller.snapshot().current;
  if (!cur) return "Nothing is playing.";
  return `▶️ **${cur.meta.title}** — requested by ${cur.requester.displayName}`;
}

function formatQueue(ctx: HandlerContext): string {
  const { current, upcoming } = ctx.controller.snapshot();
  const lines: string[] = [];
  lines.push(
    current
      ? `▶️ **${current.meta.title}** (${current.requester.displayName})`
      : "Nothing playing.",
  );
  if (upcoming.length) {
    lines.push("**Up next:**");
    upcoming
      .slice(0, 10)
      .forEach((it, i) => lines.push(`${i + 1}. ${it.meta.title} (${it.requester.displayName})`));
    if (upcoming.length > 10) lines.push(`…and ${upcoming.length - 10} more`);
  }
  return lines.join("\n");
}
