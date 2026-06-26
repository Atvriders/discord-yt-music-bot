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
    expect(() => loadWebConfig({})).toThrow();
    expect(() => loadWebConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
});
