import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerAuthRoutes } from "./routes.js";

// Mock the OAuth network layer so the callback route runs purely in-process.
const exchangeCode = vi.fn();
const fetchIdentity = vi.fn();
const revokeToken = vi.fn(async (..._a: unknown[]) => {});
// verifyState is STUBBED here (the real timing-safe comparison is covered by
// oauth.state.test.ts). The handler tests below assert that the route correctly wires
// verifyState's boolean result to the accept/reject decision: `verifyStateResult` is
// flipped to false to drive the state-mismatch branch.
let verifyStateResult = true;
vi.mock("./oauth.js", async () => {
  const actual = await vi.importActual<typeof import("./oauth.js")>("./oauth.js");
  return {
    ...actual,
    exchangeCode: (...a: unknown[]) => exchangeCode(...a),
    fetchIdentity: (...a: unknown[]) => fetchIdentity(...a),
    revokeToken: (...a: unknown[]) => revokeToken(...a),
    verifyState: () => verifyStateResult,
  };
});

const cfg = {
  clientId: "cid",
  clientSecret: "sec",
  redirectUri: "https://m/cb",
} as never;

function buildApp() {
  const app = Fastify();
  // The logout route calls reply.clearCookie, which @fastify/cookie decorates. Register it
  // so the in-isolation route tests mirror the real buildApp() wiring. (inject() awaits
  // readiness, so registering without an explicit await here is fine.)
  void app.register(cookie);
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
  verifyStateResult = true;
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

  it("returns 400 with the Discord error when ?error= is present (and exchanges nothing)", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?error=access_denied",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("access_denied");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_state when the code is missing", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?state=STATE",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_state");
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_state when verifyState rejects a mismatched state", async () => {
    verifyStateResult = false; // drive the state-mismatch branch
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=C&state=WRONG",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_state");
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});

describe("auth logout", () => {
  it("destroys the session, clears the sid cookie, and returns 204", async () => {
    const { app, session } = buildApp();
    const res = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(204);
    expect(session.destroy).toHaveBeenCalled();
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
    // clearCookie emits an expired/empty sid cookie.
    expect(cookieStr).toContain("sid=");
  });

  it("propagates a 500 when the session store fails to destroy", async () => {
    const { app, session } = buildApp();
    session.destroy.mockRejectedValueOnce(new Error("store down"));
    const res = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(500);
  });
});
