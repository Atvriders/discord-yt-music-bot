import { describe, it, expect } from "vitest";
import { buildBotBio, BIO_MAX_LENGTH } from "./bio.js";

describe("buildBotBio", () => {
  it("includes the tagline, prefix, commands, and the panel URL when a baseUrl is given", () => {
    const bio = buildBotBio({ prefix: "?", baseUrl: "https://ytbot.waterburp.com" });
    // Tagline
    expect(bio).toContain("Plays the exact YouTube audio");
    // Prefix label + the configured prefix
    expect(bio).toContain("Prefix: ?");
    // The command list, derived from the prefix
    expect(bio).toContain("?play <url|search>");
    expect(bio).toContain("?skip");
    expect(bio).toContain("?pause");
    expect(bio).toContain("?resume");
    expect(bio).toContain("?stop");
    expect(bio).toContain("?queue");
    expect(bio).toContain("?np");
    expect(bio).toContain("?remove <n>");
    expect(bio).toContain("?help");
    // Panel URL
    expect(bio).toContain("Panel: https://ytbot.waterburp.com");
  });

  it("produces the documented target shape for prefix ? + the waterburp URL", () => {
    const bio = buildBotBio({ prefix: "?", baseUrl: "https://ytbot.waterburp.com" });
    expect(bio).toBe(
      "🎵 Plays the exact YouTube audio you give it — never a mirror. " +
        "Prefix: ? · Commands: ?play <url|search>, ?skip, ?pause, ?resume, " +
        "?stop, ?queue, ?np, ?remove <n>, ?help · Panel: https://ytbot.waterburp.com",
    );
  });

  it("omits the Panel part cleanly when baseUrl is undefined", () => {
    const bio = buildBotBio({ prefix: "?" });
    expect(bio).not.toContain("Panel:");
    expect(bio).not.toMatch(/·\s*$/); // no dangling separator at the end
    expect(bio).toContain("?help");
  });

  it("omits the Panel part cleanly when baseUrl is an empty string", () => {
    const bio = buildBotBio({ prefix: "?", baseUrl: "" });
    expect(bio).not.toContain("Panel:");
    expect(bio).not.toMatch(/·\s*$/);
  });

  it("derives the command examples from a non-? prefix", () => {
    const bio = buildBotBio({ prefix: "!", baseUrl: "https://example.com" });
    expect(bio).toContain("Prefix: !");
    expect(bio).toContain("!play <url|search>");
    expect(bio).toContain("!skip");
    expect(bio).toContain("!remove <n>");
    expect(bio).toContain("!help");
    // It must NOT leak the default ? prefix into the command list.
    expect(bio).not.toContain("?play");
    expect(bio).not.toContain("?skip");
  });

  it("derives the command examples from a multi-character prefix", () => {
    const bio = buildBotBio({ prefix: "yt!" });
    expect(bio).toContain("Prefix: yt!");
    expect(bio).toContain("yt!play <url|search>");
    expect(bio).toContain("yt!help");
  });

  it("stays within Discord's application-description limit for normal input", () => {
    const bio = buildBotBio({ prefix: "?", baseUrl: "https://ytbot.waterburp.com" });
    expect(bio.length).toBeLessThanOrEqual(BIO_MAX_LENGTH);
    expect(BIO_MAX_LENGTH).toBe(400);
  });

  it("truncates gracefully and stays ≤ limit even with an absurdly long URL", () => {
    const longUrl = "https://example.com/" + "x".repeat(500);
    const bio = buildBotBio({ prefix: "?", baseUrl: longUrl });
    expect(bio.length).toBeLessThanOrEqual(BIO_MAX_LENGTH);
  });

  it("truncates gracefully and stays ≤ limit even with an absurdly long prefix", () => {
    const longPrefix = "p".repeat(500);
    const bio = buildBotBio({ prefix: longPrefix });
    expect(bio.length).toBeLessThanOrEqual(BIO_MAX_LENGTH);
  });

  it("accepts a custom commands list and uses it verbatim with the prefix", () => {
    const bio = buildBotBio({
      prefix: "?",
      commands: [{ name: "play", args: "<url>" }, { name: "stop" }],
    });
    expect(bio).toContain("?play <url>, ?stop");
    expect(bio).not.toContain("?skip");
  });
});
