import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { TrackMeta } from "../types/index.js";

const MAX = 5;

function fmtDuration(sec: number | null): string {
  if (sec === null) return "?:??";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function buildPicker(results: TrackMeta[]): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const top = results.slice(0, MAX);
  const content = top
    .map((t, i) => `**${i + 1}.** ${t.title} — ${t.channel} (${fmtDuration(t.durationSec)})`)
    .join("\n");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    top.map((t, i) =>
      new ButtonBuilder()
        .setCustomId(`pick:${t.videoId}`)
        .setLabel(String(i + 1))
        .setStyle(ButtonStyle.Primary),
    ),
  );
  return { content: content || "No results.", components: top.length ? [row] : [] };
}

export function decodePick(customId: string): string | null {
  return customId.startsWith("pick:") ? customId.slice("pick:".length) : null;
}
