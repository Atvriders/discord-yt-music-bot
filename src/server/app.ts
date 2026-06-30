import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemorySessionStore } from "../auth/session-store.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { registerRest, type RestDeps } from "./rest.js";
import { registerWebsocket, GuildBroadcaster } from "./ws.js";
import type { WebConfig } from "../config.js";

export interface AppDeps extends RestDeps {
  cfg: WebConfig;
  broadcaster?: GuildBroadcaster;
  gatewayReady?: () => boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.cfg.trustProxy, logger: false });

  // Defense-in-depth: never let an unexpected throw surface as a 500 that leaks the raw
  // error message (yt-dlp stderr, filesystem paths, stack traces) to the client. A
  // malformed-URI error (e.g. a stray decodeURIComponent on a '%') maps to a 400; anything
  // else becomes a generic 500 with a stable, non-leaky body.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof URIError) {
      return reply.code(400).send({ error: "bad_request" });
    }
    // Preserve explicit statusCodes set by validation/route logic (Fastify sets 4xx on
    // validation errors); only sanitise genuine 5xx.
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      return reply.code(500).send({ error: "internal_error" });
    }
    return reply.code(status).send({ error: err.message });
  });

  await app.register(cookie);
  await app.register(session, {
    secret: deps.cfg.sessionSecret,
    cookieName: "sid",
    store: new MemorySessionStore() as never,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/",
      httpOnly: true,
      secure: deps.cfg.secureCookies,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    // Authenticated requests are keyed by session user. For unauthenticated requests we
    // key on the raw socket address (not req.ip, which honors X-Forwarded-For when
    // trustProxy is on) so a spoofed XFF cannot mint a fresh bucket per request.
    keyGenerator: (req) => {
      const userId = (req as { session?: { userId?: string } }).session?.userId;
      if (userId) return userId;
      return req.socket.remoteAddress ?? req.ip;
    },
  });
  await app.register(websocket);

  app.get("/healthz", () => ({
    ok: true,
    gateway: deps.gatewayReady?.() ?? null,
    uptimeSec: Math.floor(process.uptime()),
  }));
  registerAuthRoutes(app, deps.cfg);
  registerRest(app, deps);
  registerWebsocket(app, {
    broadcaster: deps.broadcaster ?? new GuildBroadcaster(),
    hub: deps.hub as never,
    client: deps.client,
    adminIds: deps.adminIds,
    allowedOrigins: deps.cfg.allowedWsOrigins,
  });

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/", wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method === "GET" &&
      !req.url.startsWith("/api") &&
      !req.url.startsWith("/ws") &&
      !req.url.startsWith("/auth")
    ) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });

  return app;
}
