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
      let token;
      try {
        token = await exchangeCode(cfg, code);
      } catch {
        return reply.code(502).send({ error: "oauth_failed" });
      }
      try {
        user = await fetchIdentity(token.access_token);
      } catch {
        return reply.code(502).send({ error: "oauth_failed" });
      } finally {
        // We never keep Discord tokens. Revoke in `finally` so even a fetchIdentity
        // failure (or any later throw) still invalidates the freshly-minted token —
        // revokeToken swallows its own errors, so this is always safe.
        await revokeToken(cfg, token.access_token);
      }
      // Rotate the session id to prevent fixation, and explicitly destroy the consumed
      // pre-login session record (which still holds oauthState). regenerate() replaces
      // req.session in place but does NOT remove the old store entry, so capture its id
      // first and destroy it.
      const oldId = req.session.sessionId;
      await req.session.regenerate();
      if (oldId && oldId !== req.session.sessionId) {
        await new Promise<void>((res) => req.sessionStore.destroy(oldId, () => res()));
      }
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
