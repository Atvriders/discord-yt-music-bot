export interface SelectionContext {
  requesterChannelId: string | null;
  botChannelId: string | null;
  isAdmin: boolean;
}
export type VoiceTarget =
  | { ok: true; channelId: string; move: boolean }
  | { ok: false; reason: string };

export function selectVoiceChannel(ctx: SelectionContext): VoiceTarget {
  if (!ctx.requesterChannelId) return { ok: false, reason: "Join a voice channel first." };
  if (!ctx.botChannelId || ctx.botChannelId === ctx.requesterChannelId) {
    return { ok: true, channelId: ctx.requesterChannelId, move: false };
  }
  if (ctx.isAdmin) return { ok: true, channelId: ctx.requesterChannelId, move: true };
  return { ok: false, reason: "I'm already playing in another channel." };
}
