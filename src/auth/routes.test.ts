import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerAuthRoutes } from "./routes.js";

// Mock the OAuth network layer so the callback route runs purely in-process.
const exchangeCode = vi.fn();
const fetchIdentity = vi.fn();
const revokeToken = vi.fn(async (..._a: unknown[]) => {});
vi.mock("./oauth.js", async () => {
  const actual = await vi.importActual<typeof import("./oauth.js")>("./oauth.js");
  return {
    ...actual,
    exchangeCode: (...a: unknown[]) => exchangeCode(...a),
    fetchIdentity: (...a: unknown[]) => fetchIdentity(...a),
    revokeToken: (...a: unknown[]) => revokeToken(...a),
    // verifyState is exercised for real; force a match by stubbing it to true here.
    verifyState: () => true,
  };
});

const cfg = {
  clientId: "cid",
  clientSecret: "sec",
  redirectUri: "https://m/cb",
} as never;

function buildApp() {
  const app = Fastify();
  const destroyed: string[] = [];
  // Minimal session stub mimicking @fastify/session's surface used by the route.
  let sessionId = "old-sid";
  const session = {
    oauthState: "STATE",
    userId: undefined as string | undefined,
    user: undefined as unknown,
    get sessionId() {
      return sessionId;
    },
    regenerate: vi.fn(async () => {
      sessionId = "new-sid";
    }),
    destroy: vi.fn(async () => {}),
  };
  app.decorateRequest("session", null as never);
  app.decorateRequest("sessionStore", null as never);
  app.addHook("onRequest", async (req) => {
    (req as { session: unknown }).session = session;
    (req as { sessionStore: unknown }).sessionStore = {
      destroy: (id: string, cb: () => void) => {
        destroyed.push(id);
        cb();
      },
    };
  });
  registerAuthRoutes(app, cfg);
  return { app, session, destroyed };
}

beforeEach(() => {
  exchangeCode.mockReset();
  fetchIdentity.mockReset();
  revokeToken.mockReset().mockResolvedValue(undefined);
});

describe("auth callback", () => {
  it("revokes the token and logs the user in on success, rotating the session", async () => {
    exchangeCode.mockResolvedValue({ access_token: "AT" });
    fetchIdentity.mockResolvedValue({ id: "u1", username: "u", avatar: null });
    const { app, session, destroyed } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=C&state=STATE",
    });
    expect(res.statusCode).toBe(302);
    expect(revokeToken).toHaveBeenCalledWith(cfg, "AT");
    expect(session.regenerate).toHaveBeenCalled();
    expect(destroyed).toContain("old-sid"); // old pre-login session destroyed
    expect(session.userId).toBe("u1");
  });

  it("still revokes the token when fetchIdentity throws (returns 502)", async () => {
    exchangeCode.mockResolvedValue({ access_token: "AT" });
    fetchIdentity.mockRejectedValue(new Error("discord down"));
    const { app, session } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=C&state=STATE",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("oauth_failed");
    // The token was minted, so it must be revoked even though login failed.
    expect(revokeToken).toHaveBeenCalledWith(cfg, "AT");
    expect(session.userId).toBeUndefined();
  });

  it("does not revoke when the code exchange itself fails (no token minted)", async () => {
    exchangeCode.mockRejectedValue(new Error("bad code"));
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=C&state=STATE",
    });
    expect(res.statusCode).toBe(502);
    expect(revokeToken).not.toHaveBeenCalled();
  });
});
