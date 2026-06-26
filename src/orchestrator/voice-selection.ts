export interface SelectionContext {
  requesterChannelId: string | null;
  botChannelId: string | null;
  isAdmin: boolean;
}
export type VoiceTarget = { ok: true; channelId: string } | { ok: false; reason: string };

export function selectVoiceChannel(ctx: SelectionContext): VoiceTarget {
  if (!ctx.requesterChannelId) {
    return { ok: false, reason: "Join a voice channel first." };
  }
  if (!ctx.botChannelId || ctx.botChannelId === ctx.requesterChannelId) {
    return { ok: true, channelId: ctx.requesterChannelId };
  }
  if (ctx.isAdmin) {
    // Admins may queue from any channel; the bot does NOT relocate mid-session.
    return { ok: true, channelId: ctx.requesterChannelId };
  }
  return { ok: false, reason: "I'm already playing in another channel." };
}
