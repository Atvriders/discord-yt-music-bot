import type { FastifyInstance } from "fastify";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchIdentity,
  generateState,
  revokeToken,
  verifyState,
} from "./oauth.js";
import type { WebConfig } from "../config.js";

declare module "fastify" {
  interface Session {
    oauthState?: string;
    userId?: string;
    user?: { id: string; username: string; global_name?: string | null; avatar: string | null };
  }
}

export function registerAuthRoutes(app: FastifyInstance, cfg: WebConfig): void {
  app.get(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const state = generateState();
      req.session.oauthState = state;
      return reply.redirect(buildAuthorizeUrl(cfg, state));
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/callback",
    async (req, reply) => {
      const { code, state, error } = req.query;
      const expected = req.session.oauthState;
      req.session.oauthState = undefined;
      if (error) return reply.code(400).send({ error });
      if (!code || !state || !verifyState(state, expected)) {
        return reply.code(400).send({ error: "invalid_state" });
      }
      let user;
      try {
        const token = await exchangeCode(cfg, code);
        user = await fetchIdentity(token.access_token);
        await revokeToken(cfg, token.access_token); // we don't keep Discord tokens
      } catch {
        return reply.code(502).send({ error: "oauth_failed" });
      }
      await req.session.regenerate();
      req.session.userId = user.id;
      req.session.user = user;
      return reply.redirect("/");
    },
  );

  app.post("/auth/logout", async (req, reply) => {
    await req.session.destroy();
    return reply.clearCookie("sid", { path: "/" }).code(204).send();
  });
}
