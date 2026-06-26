import { describe, it, expect } from "vitest";
import { GatewayIntentBits } from "discord.js";
import { REQUIRED_INTENTS } from "./bot.js";

describe("bot intents", () => {
  it("requests exactly the four required intents", () => {
    expect(REQUIRED_INTENTS).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]);
  });
});
