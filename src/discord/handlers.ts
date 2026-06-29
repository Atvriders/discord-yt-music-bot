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
    let results: TrackMeta[];
    try {
      results = await ctx.youtube.search(parsed.query, ctx.searchLimit);
    } catch (err) {
      // search() throws a YtError on a non-zero yt-dlp exit and (now) a YtError(Unknown)
      // on non-JSON stdout. Surface a friendly message rather than falling through to
      // bot.ts's generic "Something went wrong".
      return msg(
        err instanceof YtError
          ? `❌ Can't search right now (${err.kind}).`
          : "❌ Search failed. Try again.",
      );
    }
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
  try {
    await ctx.controller.enqueue(meta, ctx.requester);
  } catch (err) {
    // The per-guild max-track-length guard surfaces here — show the human message
    // (e.g. "Too long — max 4h …") rather than an opaque failure.
    if (err instanceof YtError) return msg(`❌ ${err.message}`);
    throw err;
  }
  return msg(`➕ Queued **${meta.title}**.`);
}

async function handleRemove(index: number, ctx: HandlerContext): Promise<HandlerResult> {
  const upcoming = ctx.controller.snapshot().upcoming;
  const item = upcoming[index - 1];
  if (!item) return msg(`No queue item #${index}.`);
  // TOCTOU: the queue may have advanced between snapshot() and remove() (track finished
  // or a skip landed). remove() returns false when the id is no longer upcoming — don't
  // give a false "Removed" confirmation in that case.
  const removed = await ctx.controller.remove(item.id);
  if (!removed) return msg("Couldn't remove that item — it may have already played.");
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
