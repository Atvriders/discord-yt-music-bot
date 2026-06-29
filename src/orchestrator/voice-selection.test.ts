import { describe, it, expect } from "vitest";
import { selectVoiceChannel } from "./voice-selection.js";

describe("selectVoiceChannel", () => {
  it("rejects when the requester is not in a voice channel", () => {
    // Assert the full result incl. the user-facing reason (surfaced verbatim by bot.ts/handlers.ts).
    expect(
      selectVoiceChannel({ requesterChannelId: null, botChannelId: null, isAdmin: false }),
    ).toEqual({ ok: false, reason: "Join a voice channel first." });
  });
  it("joins the requester's channel when the bot is not connected", () => {
    expect(
      selectVoiceChannel({ requesterChannelId: "A", botChannelId: null, isAdmin: false }),
    ).toEqual({ ok: true, channelId: "A", move: false });
  });
  it("is a no-op when the bot is already in the requester's channel", () => {
    expect(
      selectVoiceChannel({ requesterChannelId: "A", botChannelId: "A", isAdmin: false }),
    ).toEqual({ ok: true, channelId: "A", move: false });
  });
  it("rejects a non-admin when the bot is busy in another channel", () => {
    expect(
      selectVoiceChannel({ requesterChannelId: "A", botChannelId: "B", isAdmin: false }),
    ).toEqual({ ok: false, reason: "I'm already playing in another channel." });
  });
  it("admin in a different channel returns move:true", () => {
    expect(
      selectVoiceChannel({ requesterChannelId: "A", botChannelId: "B", isAdmin: true }),
    ).toEqual({ ok: true, channelId: "A", move: true });
  });
});
