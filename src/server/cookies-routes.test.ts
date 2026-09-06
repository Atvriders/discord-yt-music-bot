import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerRest } from "./rest.js";
import type { CookieHealth, CookieResult } from "../cookies/index.js";

/**
 * The cookie console's HTTP surface. Two things are on trial here:
 *
 *  1. THE GATE. A Discord login only proves you share a guild with the bot. It must not be
 *     enough to reach a console that can replace the bot's Google session, so every route
 *     demands COOKIE_ADMIN_PASSWORD as well — and answers 404, not 403, when the console was
 *     never configured (an operator who never switched it on cannot be surprised by it existing).
 *  2. NO LEAKS. Every response body is health/verdict only. A cookie value must not appear in
 *     one even when the service misbehaves, so the "service throws" case asserts on the body.
 */

const USER = "123456789012345678";
const PASSWORD = "a-long-random-console-password";
const SECRET = "s3cr3t-SID-value-do-not-echo-9f2a1c";

const HEALTH: CookieHealth = {
  configured: true,
  source: "paste",
  updatedAt: 1_700_000_000_000,
  lastCheck: { at: 1_700_000_000_500, ok: true, reason: null },
  browserProfileAvailable: false,
};

function build(
  opts: {
    userId?: string | null;
    cookieAdminPassword?: string | null;
    cookies?: unknown;
  } = {},
) {
  const cookies = opts.cookies ?? {
    health: vi.fn((): CookieHealth => HEALTH),
    test: vi.fn(async (): Promise<CookieResult> => ({ ok: true, reason: null })),
    saveFromText: vi.fn(async (_t: string): Promise<CookieResult> => ({ ok: true, reason: null })),
    importFromBrowser: vi.fn(async (): Promise<CookieResult> => ({ ok: true, reason: null })),
  };
  const deps = {
    registry: { list: vi.fn(() => []), get: vi.fn(() => undefined) },
    youtube: { resolve: vi.fn(), search: vi.fn(), resolveUrl: vi.fn() },
    adminIds: new Set<string>(),
    searchLimit: 5,
    cookies: opts.cookies === null ? undefined : cookies,
    cookieAdminPassword:
      opts.cookieAdminPassword === undefined ? PASSWORD : opts.cookieAdminPassword,
  };
  const app = Fastify();
  app.decorateRequest("session", null as never);
  const userId = opts.userId === undefined ? USER : opts.userId;
  app.addHook("onRequest", async (req) => {
    (req as { session: unknown }).session = userId ? { userId } : {};
  });
  registerRest(app, deps as never);
  return { app, cookies: cookies as Record<string, ReturnType<typeof vi.fn>> };
}

const ROUTES = [
  { method: "GET" as const, url: "/api/cookies" },
  { method: "POST" as const, url: "/api/cookies/test" },
  { method: "POST" as const, url: "/api/cookies/import" },
];

describe("cookie console — the gate", () => {
  it("401s every route when there is no Discord session", async () => {
    const { app } = build({ userId: null });
    for (const r of ROUTES) {
      const res = await app.inject({ ...r, headers: { "x-cookie-admin": PASSWORD } });
      expect(res.statusCode).toBe(401);
    }
    const post = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: { "x-cookie-admin": PASSWORD },
      payload: { text: "x" },
    });
    expect(post.statusCode).toBe(401);
  });

  it("404s every route when COOKIE_ADMIN_PASSWORD is unset — the console is OFF", async () => {
    const { app, cookies } = build({ cookieAdminPassword: null });
    for (const r of ROUTES) {
      const res = await app.inject({ ...r, headers: { "x-cookie-admin": "anything" } });
      expect(res.statusCode).toBe(404);
    }
    // Not merely unauthorized — nothing behind the gate was even consulted.
    expect(cookies.health).not.toHaveBeenCalled();
    expect(cookies.test).not.toHaveBeenCalled();
    expect(cookies.importFromBrowser).not.toHaveBeenCalled();
  });

  it("treats an EMPTY password as unset, not as 'anyone with an empty header'", async () => {
    const { app } = build({ cookieAdminPassword: "" });
    const res = await app.inject({
      method: "GET",
      url: "/api/cookies",
      headers: { "x-cookie-admin": "" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403s a logged-in user with a missing or wrong console password", async () => {
    const { app, cookies } = build();
    expect((await app.inject({ method: "GET", url: "/api/cookies" })).statusCode).toBe(403);
    const wrong = await app.inject({
      method: "GET",
      url: "/api/cookies",
      headers: { "x-cookie-admin": "not-it" },
    });
    expect(wrong.statusCode).toBe(403);
    expect(cookies.health).not.toHaveBeenCalled();
  });

  it("lets the right password through on every route", async () => {
    const { app, cookies } = build();
    const h = { "x-cookie-admin": PASSWORD };
    const health = await app.inject({ method: "GET", url: "/api/cookies", headers: h });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual(HEALTH);

    expect(
      (await app.inject({ method: "POST", url: "/api/cookies/test", headers: h })).json(),
    ).toEqual({ ok: true, reason: null });
    expect(
      (await app.inject({ method: "POST", url: "/api/cookies/import", headers: h })).json(),
    ).toEqual({ ok: true, reason: null });
    const save = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: h,
      payload: { text: SECRET },
    });
    expect(save.statusCode).toBe(200);
    expect(cookies.saveFromText).toHaveBeenCalledWith(SECRET);
  });

  it("is NOT reachable under a bot/guild path — the jar is process-wide", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "GET",
      url: "/api/bots/1/guilds/2/cookies",
      headers: { "x-cookie-admin": PASSWORD },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("cookie console — request validation", () => {
  const h = { "x-cookie-admin": PASSWORD };

  it("rejects a non-string paste with a CookieResult, not a bare error", async () => {
    const { app, cookies } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: h,
      payload: { text: 42 },
    });
    expect(res.statusCode).toBe(400);
    // The console renders `reason`; a { error } body would surface as an empty failure.
    expect(res.json()).toEqual({ ok: false, reason: "text must be a string" });
    expect(cookies.saveFromText).not.toHaveBeenCalled();
  });

  it("rejects an over-long paste by SHAPE, quoting none of it", async () => {
    const { app, cookies } = build();
    // Between the handler's 64 KB cap and the 128 KB socket cap, so the HANDLER answers and the
    // operator gets a reason they can act on rather than a bare framework status.
    const over = `${SECRET}${"x".repeat(70 * 1024)}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: h,
      payload: { text: over },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(SECRET);
    expect(res.json().reason).toMatch(/at most 65536 characters/);
    expect(cookies.saveFromText).not.toHaveBeenCalled();
  });

  it("stops an absurd upload at the socket, above the handler cap", async () => {
    // The two caps are deliberately different: the body limit only has to stop someone streaming
    // megabytes at the route, so a merely-oversized paste still reaches the clear 400 above.
    const { app, cookies } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: h,
      payload: { text: "x".repeat(200 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(cookies.saveFromText).not.toHaveBeenCalled();
  });

  it("accepts a paste right up to the limit", async () => {
    const { app, cookies } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: h,
      payload: { text: "x".repeat(64 * 1024) },
    });
    expect(res.statusCode).toBe(200);
    expect(cookies.saveFromText).toHaveBeenCalled();
  });
});

describe("cookie console — failure modes never leak and never 500", () => {
  const h = { "x-cookie-admin": PASSWORD };

  it("503s with a content-free body when the console is not wired into this server", async () => {
    const { app } = build({ cookies: null });
    const health = await app.inject({ method: "GET", url: "/api/cookies", headers: h });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({
      configured: false,
      source: "none",
      updatedAt: null,
      lastCheck: null,
      browserProfileAvailable: false,
    });
    const test = await app.inject({ method: "POST", url: "/api/cookies/test", headers: h });
    expect(test.statusCode).toBe(503);
    expect(test.json().ok).toBe(false);
  });

  it("turns a throwing service into a CookieResult, never a 500 and never its message", async () => {
    // The service is written not to reject; if it ever does, the message could carry the jar
    // path and the yt-dlp stderr slice that names it. That must not reach the client.
    const boom = new Error(`yt-dlp failed reading ${SECRET}`);
    const { app } = build({
      cookies: {
        health: vi.fn(() => {
          throw boom;
        }),
        test: vi.fn(async () => {
          throw boom;
        }),
        saveFromText: vi.fn(async () => {
          throw boom;
        }),
        importFromBrowser: vi.fn(async () => {
          throw boom;
        }),
      },
    });

    const health = await app.inject({ method: "GET", url: "/api/cookies", headers: h });
    expect(health.statusCode).toBe(200);
    expect(health.json().configured).toBe(false);
    expect(health.body).not.toContain(SECRET);

    for (const url of ["/api/cookies/test", "/api/cookies/import"]) {
      const res = await app.inject({ method: "POST", url, headers: h });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(false);
      expect(res.body).not.toContain(SECRET);
    }

    const save = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: h,
      payload: { text: SECRET },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().ok).toBe(false);
    expect(save.body).not.toContain(SECRET);
  });

  it("passes the service's own warning through untouched", async () => {
    const warning = "saved, but this jar carries no YouTube sign-in cookies";
    const { app } = build({
      cookies: {
        health: vi.fn((): CookieHealth => HEALTH),
        test: vi.fn(async () => ({ ok: true, reason: null })),
        saveFromText: vi.fn(async () => ({ ok: true, reason: null, warning })),
        importFromBrowser: vi.fn(async () => ({ ok: true, reason: null })),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/cookies",
      headers: h,
      payload: { text: "x" },
    });
    expect(res.json()).toEqual({ ok: true, reason: null, warning });
  });
});

describe("levels endpoint", () => {
  const LEVELS = { fps: 10, bands: 40, data: new Uint8Array(120).fill(7) };

  function buildLevels(over: { levels?: unknown; userId?: string | null } = {}) {
    const get = vi.fn(async () => LEVELS);
    const deps = {
      registry: { list: vi.fn(() => []), get: vi.fn(() => undefined) },
      youtube: { resolve: vi.fn(), search: vi.fn(), resolveUrl: vi.fn() },
      adminIds: new Set<string>(),
      searchLimit: 5,
      levels: over.levels === null ? undefined : (over.levels ?? { get }),
    };
    const app = Fastify();
    app.decorateRequest("session", null as never);
    const userId = over.userId === undefined ? USER : over.userId;
    app.addHook("onRequest", async (req) => {
      (req as { session: unknown }).session = userId ? { userId } : {};
    });
    registerRest(app, deps as never);
    return { app, get };
  }

  it("serves the timeline as raw bytes with the shape in headers", async () => {
    const { app, get } = buildLevels();
    const res = await app.inject({ method: "GET", url: "/api/levels/aaaaaaaaaaa?durationSec=210" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    // The client needs both to index the buffer; without them the bytes are meaningless.
    expect(res.headers["x-levels-fps"]).toBe("10");
    expect(res.headers["x-levels-bands"]).toBe("40");
    expect(res.rawPayload.length).toBe(120);
    expect(get).toHaveBeenCalledWith("aaaaaaaaaaa", 210);
  });

  it("requires a session", async () => {
    const { app } = buildLevels({ userId: null });
    expect((await app.inject({ method: "GET", url: "/api/levels/aaaaaaaaaaa" })).statusCode).toBe(
      401,
    );
  });

  it("never lets a path-shaped videoId reach the analyser", async () => {
    // The id is interpolated into a filename, so the guard is about what gets THROUGH, not about
    // which rejection code comes back: the router turns away anything with a slash or a `..`
    // before the handler runs, and the handler's own pattern catches the rest.
    const { app, get } = buildLevels();
    for (const bad of ["..", "a/b", "../../etc/passwd", "a.b", "x".repeat(80)]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/levels/${encodeURIComponent(bad)}`,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("400s a single-segment id that is still not a valid key", async () => {
    const { app, get } = buildLevels();
    expect((await app.inject({ method: "GET", url: "/api/levels/a.b" })).statusCode).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("404s when the track has no analysis rather than inventing one", async () => {
    const { app } = buildLevels({ levels: { get: vi.fn(async () => null) } });
    expect((await app.inject({ method: "GET", url: "/api/levels/aaaaaaaaaaa" })).statusCode).toBe(
      404,
    );
  });

  it("404s (never 500s) when the analyser throws", async () => {
    const { app } = buildLevels({
      levels: {
        get: vi.fn(async () => {
          throw new Error("ffmpeg exploded");
        }),
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/levels/aaaaaaaaaaa" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("ffmpeg");
  });

  it("404s when no analyser is wired at all", async () => {
    const { app } = buildLevels({ levels: null });
    expect((await app.inject({ method: "GET", url: "/api/levels/aaaaaaaaaaa" })).statusCode).toBe(
      404,
    );
  });
});
