import { describe, it, expect } from "vitest";
import { loadWebConfig } from "./config.js";

const base = {
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "secret",
  PUBLIC_BASE_URL: "https://music.example.com",
  SESSION_SECRET: "x".repeat(32),
};

describe("loadWebConfig", () => {
  it("derives redirectUri from PUBLIC_BASE_URL and applies defaults", () => {
    const c = loadWebConfig(base);
    expect(c.redirectUri).toBe("https://music.example.com/auth/callback");
    expect(c.port).toBe(8080);
    expect(c.allowedWsOrigins).toEqual(["https://music.example.com"]);
    expect(c.secureCookies).toBe(false); // NODE_ENV unset → not production
  });
  it("strips a trailing slash from PUBLIC_BASE_URL", () => {
    expect(loadWebConfig({ ...base, PUBLIC_BASE_URL: "https://m.example.com/" }).redirectUri).toBe(
      "https://m.example.com/auth/callback",
    );
  });
  it("honors OAUTH_REDIRECT_URI override and production secure cookies", () => {
    const c = loadWebConfig({
      ...base,
      OAUTH_REDIRECT_URI: "https://m/cb",
      NODE_ENV: "production",
    });
    expect(c.redirectUri).toBe("https://m/cb");
    expect(c.secureCookies).toBe(true);
  });
  it("throws when a required var is missing", () => {
    expect(() => loadWebConfig({})).toThrow(/DISCORD_CLIENT_ID/);
    const { DISCORD_CLIENT_SECRET: _s, ...noSecret } = base;
    expect(() => loadWebConfig(noSecret)).toThrow(/DISCORD_CLIENT_SECRET/);
    const { PUBLIC_BASE_URL: _u, ...noUrl } = base;
    expect(() => loadWebConfig(noUrl)).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadWebConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("defaults trustProxy to false (opt-in) and honors TRUST_PROXY=true", () => {
    // Defaulting to true would let unauthenticated clients spoof X-Forwarded-For and
    // bypass the rate limiter; it must be explicitly opted in.
    expect(loadWebConfig(base).trustProxy).toBe(false);
    expect(loadWebConfig({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadWebConfig({ ...base, TRUST_PROXY: "false" }).trustProxy).toBe(false);
  });

  it("rejects an out-of-range PORT", () => {
    expect(() => loadWebConfig({ ...base, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadWebConfig({ ...base, PORT: "0" })).toThrow(/PORT/);
  });
});

describe("allowedWsOrigins — the panel can never reject its own page", () => {
  const base = {
    DISCORD_CLIENT_ID: "1",
    DISCORD_CLIENT_SECRET: "s",
    PUBLIC_BASE_URL: "https://ytbot.example.com",
    SESSION_SECRET: "x".repeat(32),
  };

  it("allows PUBLIC_BASE_URL with nothing else configured", () => {
    expect(loadWebConfig(base).allowedWsOrigins).toEqual(["https://ytbot.example.com"]);
  });

  it("STILL allows PUBLIC_BASE_URL when ALLOWED_WS_ORIGINS names something else", () => {
    // The exact live failure: compose shipped ALLOWED_WS_ORIGINS="http://localhost:8080", which
    // REPLACED the real origin, so the server rejected the socket from the very page it served
    // and the panel sat there with an empty now-playing box. The var is additive now.
    const cfg = loadWebConfig({ ...base, ALLOWED_WS_ORIGINS: "http://localhost:8080" });
    expect(cfg.allowedWsOrigins).toContain("https://ytbot.example.com");
    expect(cfg.allowedWsOrigins).toContain("http://localhost:8080");
  });

  it("adds extra origins for a second address", () => {
    const cfg = loadWebConfig({
      ...base,
      ALLOWED_WS_ORIGINS: "http://192.0.2.10:8080, https://alt.example.com",
    });
    expect(cfg.allowedWsOrigins).toEqual([
      "https://ytbot.example.com",
      "http://192.0.2.10:8080",
      "https://alt.example.com",
    ]);
  });

  it("does not list the same origin twice", () => {
    const cfg = loadWebConfig({ ...base, ALLOWED_WS_ORIGINS: "https://ytbot.example.com" });
    expect(cfg.allowedWsOrigins).toEqual(["https://ytbot.example.com"]);
  });

  it("ignores blank entries and trailing slashes", () => {
    // A pasted origin with a trailing slash never matches a browser Origin header, which has
    // none — a silent mismatch that looks identical to a typo.
    const cfg = loadWebConfig({ ...base, ALLOWED_WS_ORIGINS: " , https://alt.example.com/ ,, " });
    expect(cfg.allowedWsOrigins).toEqual(["https://ytbot.example.com", "https://alt.example.com"]);
  });
});
