import { describe, it, expect } from "vitest";
import { selectVoiceChannel } from "./voice-selection.js";

describe("selectVoiceChannel", () => {
  it("rejects when the requester is not in a voice channel", () => {
    const r = selectVoiceChannel({ requesterChannelId: null, botChannelId: null, isAdmin: false });
    expect(r.ok).toBe(false);
  });
  it("joins the requester's channel when the bot is not connected", () => {
    expect(
      selectVoiceChannel({ requesterChannelId: "A", botChannelId: null, isAdmin: false }),
    ).toEqual({ ok: true, channelId: "A" });
  });
  it("is a no-op when the bot is already in the requester's channel", () => {
    expect(
      selectVoiceChannel({ requesterChannelId: "A", botChannelId: "A", isAdmin: false }),
    ).toEqual({ ok: true, channelId: "A" });
  });
  it("rejects a non-admin when the bot is busy in another channel", () => {
    const r = selectVoiceChannel({ requesterChannelId: "A", botChannelId: "B", isAdmin: false });
    expect(r.ok).toBe(false);
  });
  it("lets an admin queue from another channel", () => {
    expect(
      selectVoiceChannel({ requesterChannelId: "A", botChannelId: "B", isAdmin: true }),
    ).toEqual({ ok: true, channelId: "A" });
  });
});
