import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import type { Command } from "./command-parser.js";
import { parseInput } from "../youtube/url-parser.js";
import { resolveSpotifyQuery } from "../youtube/spotify.js";
import { buildPicker } from "./picker.js";
import { selectVoiceChannel } from "../orchestrator/voice-selection.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
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
    | "setVolume"
    | "updateSettings"
  >;
  youtube: {
    resolve(videoId: string): Promise<TrackMeta>;
    search(query: string, limit: number): Promise<TrackMeta[]>;
    /** Resolve a direct non-YouTube media URL (SoundCloud) to a playable track. */
    resolveUrl(url: string): Promise<TrackMeta>;
  };
  /**
   * Resolve a Spotify track URL to a "<track> <artist>" YouTube search string (best-effort;
   * null on failure). Defaults to the real spotify.ts resolver; injectable for tests.
   */
  spotify?: (url: string) => Promise<string | null>;
  requester: Requester;
  requesterChannelId: string | null;
  botChannelId: string | null;
  /** The text channel id the command was sent in (used by `?channel` to set the restriction). */
  channelId: string;
  isAdmin: boolean;
  searchLimit: number;
}

export type HandlerResult =
  | { type: "message"; content: string }
  | { type: "picker"; content: string; components: ActionRowBuilder<ButtonBuilder>[] };

const HELP = [
  "**Commands**",
  "`?play <link | search terms>` — queue a YouTube/SoundCloud/Spotify link, or search and pick",
  "`?skip` `?pause` `?resume` `?stop` — playback control",
  "`?queue` `?np` — show the queue / now playing",
  "`?history` — show recently played tracks",
  "`?remove <n>` — remove queue item n",
  "`?volume <0-200>` — set playback volume (100 = normal)",
  "`?channel` — (admin) restrict the bot to this channel · `?channel off` to clear",
].join("\n");

function msg(content: string): HandlerResult {
  return { type: "message", content };
}

/**
 * Friendly message for a resolve/resolveUrl failure. Age-restricted gets a specific,
 * actionable hint: the ladder's no-login bypass clients (tv_embedded/mediaconnect) handle
 * embeddable age-restricted videos automatically, so a persistent age_restricted error means
 * an embedding-disabled video that genuinely needs an 18+ account's cookies (YT_COOKIES).
 */
function resolveErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof YtError) {
    if (err.kind === YtErrorKind.AgeRestricted) {
      return "❌ That video is age-restricted and has embedding disabled — the host can add an 18+ account's cookies (YT_COOKIES) to play these.";
    }
    return `❌ Can't play that (${err.kind}).`;
  }
  return fallback;
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
    case "volume": {
      const settings = ctx.controller.setVolume(cmd.percent);
      return msg(`🔊 Volume set to **${settings.volume}%**.`);
    }
    case "channel":
      return handleChannel(cmd.mode, ctx);
    case "queue":
      return msg(formatQueue(ctx));
    case "np":
      return msg(formatNowPlaying(ctx));
    case "history":
      return msg(formatHistory(ctx));
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

  // Spotify: audio is DRM-locked, so resolve the track to a search string, find the closest
  // YouTube video, and play THAT (the exact-link rule is relaxed here by explicit design).
  if (parsed.kind === "spotify") {
    const resolveSpotify = ctx.spotify ?? resolveSpotifyQuery;
    let query: string | null;
    try {
      query = await resolveSpotify(parsed.url);
    } catch {
      query = null;
    }
    if (!query) {
      return msg(
        "❌ Couldn't read that Spotify track. Try the song's YouTube link, or search by name.",
      );
    }
    let results: TrackMeta[];
    try {
      results = await ctx.youtube.search(query, 1);
    } catch (err) {
      return msg(
        err instanceof YtError
          ? `❌ Can't search right now (${err.kind}).`
          : "❌ Search failed. Try again.",
      );
    }
    const match = results[0];
    if (!match) return msg(`❌ No YouTube match for that Spotify track (“${query}”).`);
    return enqueueResolved(match, ctx, "🎧 Spotify → closest YouTube match");
  }

  // SoundCloud (direct URL): play the exact track via yt-dlp's resolver.
  if (parsed.kind === "url") {
    let meta: TrackMeta;
    try {
      meta = await ctx.youtube.resolveUrl(parsed.url);
    } catch (err) {
      return msg(resolveErrorMessage(err, "❌ Failed to load that link."));
    }
    return enqueueResolved(meta, ctx, "SoundCloud");
  }

  // exact YouTube video
  let meta: TrackMeta;
  try {
    meta = await ctx.youtube.resolve(parsed.videoId);
  } catch (err) {
    return msg(resolveErrorMessage(err, "❌ Failed to load that video."));
  }
  return enqueueResolved(meta, ctx);
}

/**
 * Shared tail for every resolved track (YouTube video / SoundCloud / Spotify match): pick the
 * voice target, join it, enqueue, and confirm. `note` is an optional parenthetical source
 * label appended to the confirmation (e.g. "SoundCloud", "Spotify → YouTube match").
 */
async function enqueueResolved(
  meta: TrackMeta,
  ctx: HandlerContext,
  note?: string,
): Promise<HandlerResult> {
  const target = selectVoiceChannel({
    requesterChannelId: ctx.requesterChannelId,
    botChannelId: ctx.botChannelId,
    isAdmin: ctx.isAdmin,
  });
  if (!target.ok) return msg(`❌ ${target.reason}`);
  // Voice-join can fail for concrete, user-actionable reasons (missing CONNECT permission,
  // the channel was deleted, a transient gateway/network error). Without this guard the
  // rejection escapes to bot.ts's generic "Something went wrong", and a failed moveTo —
  // which destroys the old session before reconnecting — would silently leave the guild with
  // no session and only an opaque error. Surface a concrete, actionable message instead.
  try {
    if (target.move) await ctx.controller.moveTo(target.channelId);
    else await ctx.controller.ensureConnected(target.channelId);
  } catch {
    return msg(
      "❌ Couldn't join that voice channel — check my permissions and that the channel still exists.",
    );
  }
  try {
    await ctx.controller.enqueue(meta, ctx.requester);
  } catch (err) {
    // The per-guild max-track-length guard surfaces here — show the human message
    // (e.g. "Too long — max 4h …") rather than an opaque failure.
    if (err instanceof YtError) return msg(`❌ ${err.message}`);
    throw err;
  }
  return msg(`➕ Queued **${meta.title}**.${note ? ` _(${note})_` : ""}`);
}

/**
 * `?channel` (admin-only): restrict the bot to the channel the command ran in, or
 * `?channel off` to remove the restriction. Gated by the same admin check the other
 * admin actions use (ctx.isAdmin); non-admins get a friendly rejection and nothing
 * changes. Applies the change via the controller settings update (commandChannelId).
 */
function handleChannel(mode: "set" | "off", ctx: HandlerContext): HandlerResult {
  if (!ctx.isAdmin) {
    return msg("❌ Only an admin can change the bot's command channel.");
  }
  if (mode === "off") {
    ctx.controller.updateSettings({ commandChannelId: null });
    return msg("✅ Channel restriction removed — commands now work in any channel.");
  }
  ctx.controller.updateSettings({ commandChannelId: ctx.channelId });
  return msg(`✅ Commands now restricted to <#${ctx.channelId}>.`);
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

function formatHistory(ctx: HandlerContext): string {
  // history is oldest-first (pushed as each track ends); show the last ~10, most-recent
  // first, so "1." is the track that just finished.
  const history = ctx.controller.snapshot().history ?? [];
  if (history.length === 0) return "No history yet.";
  const recent = history.slice(-10).reverse();
  const lines = ["**Recently played:**"];
  recent.forEach((it, i) => lines.push(`${i + 1}. ${it.meta.title} (${it.requester.displayName})`));
  return lines.join("\n");
}
