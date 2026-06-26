import crypto from "node:crypto";
import type { WebConfig } from "../config.js";

export const DISCORD = {
  AUTHORIZE_URL: "https://discord.com/oauth2/authorize",
  TOKEN_URL: "https://discord.com/api/oauth2/token",
  REVOKE_URL: "https://discord.com/api/oauth2/token/revoke",
  USER_URL: "https://discord.com/api/v10/users/@me",
  SCOPE: "identify guilds",
} as const;

export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function verifyState(received: string, expected: string | undefined): boolean {
  if (!received || !expected || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function buildAuthorizeUrl(
  cfg: Pick<WebConfig, "clientId" | "redirectUri">,
  state: string,
): string {
  const url = new URL(DISCORD.AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("scope", DISCORD.SCOPE);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "none");
  return url.toString();
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar: string | null;
}

export function avatarUrl(user: Pick<DiscordUser, "id" | "avatar">, size = 128): string {
  if (user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
  }
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function exchangeCode(
  cfg: Pick<WebConfig, "clientId" | "clientSecret" | "redirectUri">,
  code: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(DISCORD.TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const token = (await res.json()) as TokenResponse;
  const granted = new Set(token.scope.split(" "));
  if (!granted.has("identify") || !granted.has("guilds")) {
    throw new Error("insufficient OAuth scope (need identify and guilds)");
  }
  return token;
}

export async function fetchIdentity(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(DISCORD.USER_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`identity fetch failed (${res.status})`);
  return (await res.json()) as DiscordUser;
}

export async function revokeToken(
  cfg: Pick<WebConfig, "clientId" | "clientSecret">,
  token: string,
): Promise<void> {
  await fetch(DISCORD.REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, token }),
  }).catch(() => undefined);
}
