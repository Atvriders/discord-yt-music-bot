import { describe, it, expect, vi } from "vitest";
import { buildApp } from "./app.js";

const cfg = {
  clientId: "cid",
  clientSecret: "sec",
  publicBaseUrl: "https://m",
  redirectUri: "https://m/auth/callback",
  sessionSecret: "x".repeat(32),
  port: 8080,
  host: "0.0.0.0",
  trustProxy: true,
  allowedWsOrigins: ["https://m"],
  nodeEnv: "test",
  secureCookies: false,
};
function deps() {
  return {
    cfg,
    hub: { get: vi.fn(() => ({ snapshot: () => ({}), queue: { on: vi.fn() } })) },
    youtube: { resolve: vi.fn(), search: vi.fn() },
    client: { guilds: { cache: new Map() } },
    adminIds: new Set<string>(),
    searchLimit: 5,
  } as never;
}

describe("buildApp", () => {
  it("serves /healthz", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
  it("/auth/login redirects to Discord with a state cookie set", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("discord.com/oauth2/authorize");
    expect(res.headers.location).toContain("state=");
    expect(res.headers["set-cookie"]).toBeTruthy();
    expect(res.headers["set-cookie"]).toContain("sid=");
    await app.close();
  });
  it("guards /api/me when logged out", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
