import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { MemorySessionStore } from "../auth/session-store.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { registerRest, type RestDeps } from "./rest.js";
import { registerWebsocket, GuildBroadcaster } from "./ws.js";
import type { WebConfig } from "../config.js";

export interface AppDeps extends RestDeps {
  cfg: WebConfig;
  broadcaster?: GuildBroadcaster;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.cfg.trustProxy, logger: false });

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
    keyGenerator: (req) => (req as { session?: { userId?: string } }).session?.userId ?? req.ip,
  });
  await app.register(websocket);

  app.get("/healthz", async () => ({ ok: true }));
  registerAuthRoutes(app, deps.cfg);
  registerRest(app, deps);
  registerWebsocket(app, {
    broadcaster: deps.broadcaster ?? new GuildBroadcaster(),
    hub: deps.hub as never,
    client: deps.client,
    adminIds: deps.adminIds,
    allowedOrigins: deps.cfg.allowedWsOrigins,
  });
  return app;
}
