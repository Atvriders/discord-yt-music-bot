import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "./app.js";

// Mock ONLY the OAuth network layer (token/identity/revoke). verifyState and the rest of the
// auth flow run for real against the real @fastify/session + MemorySessionStore wired by
// buildApp, so these tests actually exercise the CSRF state roundtrip from /auth/login
// through /auth/callback (which the isolated routes.test.ts stubs verifyState out of).
const exchangeCode = vi.fn();
const fetchIdentity = vi.fn();
const revokeToken = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../auth/oauth.js", async () => {
  const actual = await vi.importActual<typeof import("../auth/oauth.js")>("../auth/oauth.js");
  return {
    ...actual,
    exchangeCode: (...a: unknown[]) => exchangeCode(...a),
    fetchIdentity: (...a: unknown[]) => fetchIdentity(...a),
    revokeToken: (...a: unknown[]) => revokeToken(...a),
  };
});

beforeEach(() => {
  exchangeCode.mockReset();
  fetchIdentity.mockReset();
  revokeToken.mockReset().mockResolvedValue(undefined);
});

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
  // A controller stub with the top-level members both server interfaces touch:
  // ControllerLike needs `on`/`snapshot`; the old nested `queue.on` matched neither.
  const hub = { get: vi.fn(() => ({ on: vi.fn(), snapshot: vi.fn(() => ({})) })) };
  const client = { guilds: { cache: new Map() } };
  // Both rest.ts and ws.ts now resolve their per-bot client + hub through the registry
  // instead of a single top-level client/hub. One bot ("1") is enough to exercise the
  // health/auth/static/error paths these tests cover.
  const bot = { id: "1", name: "Bot 1", client, hub };
  const registry = { list: () => [bot], get: (id: string) => (id === "1" ? bot : undefined) };
  return {
    cfg,
    registry,
    youtube: { resolve: vi.fn(), search: vi.fn() },
    adminIds: new Set<string>(),
    searchLimit: 5,
  } as never;
}

describe("buildApp", () => {
  it("serves /healthz", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    const body = res.json() as { ok: boolean; gateway: boolean | null; uptimeSec: number };
    expect(body.ok).toBe(true);
    expect(body.gateway).toBeNull();
    expect(typeof body.uptimeSec).toBe("number");
    await app.close();
  });
  it("/auth/login redirects to Discord with a real (non-empty) state and a session cookie", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin + loc.pathname).toBe("https://discord.com/oauth2/authorize");
    // Validate the actual state VALUE, not just the param name: a 32-byte base64url state is
    // 43 chars. This catches an empty/corrupt state that `toContain("state=")` would miss.
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
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

describe("buildApp /auth/callback (real verifyState + real session roundtrip)", () => {
  // Drive /auth/login to obtain a real sid cookie and the state persisted into that session,
  // then replay /auth/callback with the same cookie. This is the only way to verify the state
  // stored at login is actually checked at callback (the unit test stubs verifyState).
  async function login(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    const setCookie = res.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string);
    const cookie = raw.split(";")[0]!; // "sid=<value>"
    const state = new URL(res.headers.location as string).searchParams.get("state")!;
    return { cookie, state };
  }

  it("rejects a mismatched state with 400 invalid_state (real CSRF check)", async () => {
    const app = await buildApp(deps());
    const { cookie } = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=C&state=DEFINITELY_WRONG",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_state");
    expect(exchangeCode).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts the correct captured state, exchanges the code, and logs the user in (302)", async () => {
    exchangeCode.mockResolvedValue({ access_token: "AT" });
    fetchIdentity.mockResolvedValue({ id: "u1", username: "u", avatar: null });
    const app = await buildApp(deps());
    const { cookie, state } = await login(app);
    const res = await app.inject({
      method: "GET",
      url: `/auth/callback?code=C&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(exchangeCode).toHaveBeenCalled();
    // Session regeneration issues a fresh sid cookie on the callback response.
    expect(res.headers["set-cookie"]).toBeTruthy();
    await app.close();
  });
});
