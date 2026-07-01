import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { GuildBroadcaster, isAllowedOrigin, registerWebsocket, type WsDeps } from "./ws.js";

const USER = "123456789012345678";
const GUILD = "234567890123456789";
const BOT = "1";
const ORIGIN = "https://m";

describe("isAllowedOrigin", () => {
  it("matches the allowlist exactly", () => {
    const allow = ["https://m.example.com"];
    expect(isAllowedOrigin("https://m.example.com", allow)).toBe(true);
    expect(isAllowedOrigin("https://evil.com", allow)).toBe(false);
    expect(isAllowedOrigin(undefined, allow)).toBe(false);
  });
});

describe("GuildBroadcaster", () => {
  it("broadcasts only to subscribers of a (bot, guild)", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn(),
      c = vi.fn();
    b.subscribe(BOT, "G1", a);
    b.subscribe(BOT, "G2", c);
    b.broadcast(BOT, "G1", { type: "state", state: 1 });
    expect(a).toHaveBeenCalledWith({ type: "state", state: 1 });
    expect(c).not.toHaveBeenCalled();
  });
  it("keys subscriptions by (botId, guildId): botB/G1 is NOT delivered to a botA/G1 subscriber", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn();
    b.subscribe("botA", "G1", a);
    // Same guild, different bot — a distinct composite key, so this must not reach `a`.
    b.broadcast("botB", "G1", { type: "state", state: 1 });
    expect(a).not.toHaveBeenCalled();
    // The matching (botA, G1) broadcast still reaches it.
    b.broadcast("botA", "G1", { type: "state", state: 2 });
    expect(a).toHaveBeenCalledWith({ type: "state", state: 2 });
  });
  it("fans out to every subscriber of a (bot, guild) (Set-based, not last-writer-wins)", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn(),
      b2 = vi.fn();
    b.subscribe(BOT, "G1", a);
    b.subscribe(BOT, "G1", b2);
    b.broadcast(BOT, "G1", { type: "state", state: 1 });
    expect(a).toHaveBeenCalledWith({ type: "state", state: 1 });
    expect(b2).toHaveBeenCalledWith({ type: "state", state: 1 });
  });
  it("stops sending after unsubscribe", () => {
    const b = new GuildBroadcaster();
    const a = vi.fn();
    b.subscribe(BOT, "G1", a);
    b.unsubscribe(BOT, "G1", a);
    b.broadcast(BOT, "G1", { type: "state", state: 1 });
    expect(a).not.toHaveBeenCalled();
  });
  it("attach wires controller 'changed' to a self-describing state broadcast (once per bot+guild)", () => {
    const b = new GuildBroadcaster();
    const controller = Object.assign(new EventEmitter(), {
      snapshot: () => ({ current: null, upcoming: [], history: [], paused: false }),
    });
    const sub = vi.fn();
    b.attach(BOT, "G1", controller as never);
    b.attach(BOT, "G1", controller as never); // second attach must NOT double-wire
    b.subscribe(BOT, "G1", sub);
    controller.emit("changed");
    expect(sub).toHaveBeenCalledTimes(1);
    // Pushed frames must carry guildId so a multi-guild socket can route them.
    expect(sub).toHaveBeenCalledWith(expect.objectContaining({ type: "state", guildId: "G1" }));
  });
});

describe("registerWebsocket (integration)", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  // Boot a real listening Fastify with @fastify/websocket + registerWebsocket. `userId` is
  // injected as the session (mimicking @fastify/session) and `allow` toggles canControl by
  // making the guild member fetch resolve (allowed) or reject (forbidden).
  async function boot(opts: {
    userId?: string | null;
    allow?: { value: boolean };
    revalidateMs?: number;
    broadcaster?: GuildBroadcaster;
  }): Promise<{
    url: string;
    deps: WsDeps;
    allow: { value: boolean };
    controller: EventEmitter & { snapshot: () => unknown };
  }> {
    const allow = opts.allow ?? { value: true };
    const guild = {
      members: {
        fetch: vi.fn(async (id: string) => {
          if (!allow.value) throw new Error("Unknown Member");
          return { id };
        }),
      },
    };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } } as never;
    // A real EventEmitter-backed controller so attach()'s on('changed', …) wiring is exercised
    // end-to-end: emitting 'changed' must reach a subscribed socket. A plain { on: () => {} }
    // stub silently discarded the listener and could not catch a broken/removed attach().
    const controller = Object.assign(new EventEmitter(), {
      snapshot: () => ({ current: null, upcoming: [], history: [], paused: false }),
    });
    // The socket resolves its hub + client from the registry by the query-string botId; only
    // BOT is registered, so an unknown botId resolves to undefined (see the 1008 test below).
    const registry = {
      get: (id: string) =>
        id === BOT ? { hub: { get: () => controller as never }, client } : undefined,
    };
    const deps: WsDeps = {
      broadcaster: opts.broadcaster ?? new GuildBroadcaster(),
      registry,
      adminIds: new Set<string>(),
      allowedOrigins: [ORIGIN],
      revalidateMs: opts.revalidateMs,
    };
    app = Fastify();
    await app.register(websocket);
    // Stand in for @fastify/session: attach the session before registerWebsocket's hooks.
    const userId = opts.userId === undefined ? USER : opts.userId;
    app.addHook("onRequest", async (req) => {
      (req as { session: unknown }).session = userId ? { userId } : {};
    });
    registerWebsocket(app, deps);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    // The socket is bot- and guild-scoped via the query string (/ws?botId=&guildId=).
    return {
      url: `ws://127.0.0.1:${port}/ws?botId=${BOT}&guildId=${GUILD}`,
      deps,
      allow,
      controller,
    };
  }

  // Reject on an unexpected close/error so a missing/wrong message fails fast with a
  // descriptive error instead of hanging until vitest's default 5 s timeout (which gives no
  // diagnostic). Diagnostic-quality only — currently-passing tests are unaffected.
  function nextMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((res, rej) => {
      ws.once("message", (d) => res(JSON.parse(d.toString())));
      ws.once("error", rej);
      ws.once("close", (code) => rej(new Error(`socket closed (code ${code}) before a message`)));
    });
  }
  function closed(ws: WebSocket): Promise<number> {
    return new Promise((res, rej) => {
      ws.once("close", (code) => res(code));
      ws.once("error", rej);
    });
  }

  it("rejects a disallowed Origin with HTTP 403 bad_origin", async () => {
    const { url } = await boot({});
    const ws = new WebSocket(url, { headers: { origin: "https://evil.com" } });
    const result = await new Promise<{ statusCode: number | undefined; body: string }>((res) => {
      ws.once("unexpected-response", (_req, response) => {
        let body = "";
        response.on("data", (c) => (body += c));
        response.on("end", () => res({ statusCode: response.statusCode, body }));
      });
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toContain("bad_origin");
  });

  it("closes an unauthenticated socket with code 1008", async () => {
    const { url } = await boot({ userId: null });
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    const code = await closed(ws);
    expect(code).toBe(1008);
  });

  it("closes with 1008 when the botId query param is missing", async () => {
    const { url } = await boot({});
    // Strip botId (keep guildId) — the route requires BOTH from the query string.
    const noBot = url.replace(/botId=[^&]*&/, "");
    const ws = new WebSocket(noBot, { headers: { origin: ORIGIN } });
    const code = await closed(ws);
    expect(code).toBe(1008);
  });

  it("closes with 1008 when the guildId query param is missing", async () => {
    const { url } = await boot({});
    // Strip guildId (keep botId) — the route requires BOTH from the query string.
    const noGuild = url.replace(/&guildId=[^&]*/, "");
    const ws = new WebSocket(noGuild, { headers: { origin: ORIGIN } });
    const code = await closed(ws);
    expect(code).toBe(1008);
  });

  it("closes with 1008 when the botId is unknown to the registry", async () => {
    const { url } = await boot({});
    // registry.get() returns undefined for any botId other than BOT — an unroutable socket.
    const unknownBot = url.replace(/botId=[^&]*/, "botId=999");
    const ws = new WebSocket(unknownBot, { headers: { origin: ORIGIN } });
    const code = await closed(ws);
    expect(code).toBe(1008);
  });

  it("a subscribe without permission yields a forbidden error and no broadcaster.subscribe", async () => {
    const broadcaster = new GuildBroadcaster();
    const subSpy = vi.spyOn(broadcaster, "subscribe");
    const { url } = await boot({ allow: { value: false }, broadcaster });
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ subscribe: GUILD }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "error", guildId: GUILD, reason: "forbidden" });
    expect(subSpy).not.toHaveBeenCalled();
    ws.close();
  });

  it("a permitted subscribe returns an immediate state snapshot and registers the send", async () => {
    const broadcaster = new GuildBroadcaster();
    const subSpy = vi.spyOn(broadcaster, "subscribe");
    const { url } = await boot({ broadcaster });
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ subscribe: GUILD }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "state", guildId: GUILD });
    expect(subSpy).toHaveBeenCalledWith(BOT, GUILD, expect.any(Function));
    ws.close();
  });

  it("a controller 'changed' event reaches the subscribed socket as a state frame", async () => {
    const { url, controller } = await boot({});
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ subscribe: GUILD }));
    await nextMessage(ws); // initial snapshot
    // Drive the real controller; attach() must have wired this through to the broadcaster.
    controller.emit("changed");
    const frame = await nextMessage(ws);
    expect(frame).toMatchObject({ type: "state", guildId: GUILD });
    ws.close();
  });

  it("an explicit {unsubscribe} stops further broadcasts to the socket", async () => {
    const broadcaster = new GuildBroadcaster();
    const unsubSpy = vi.spyOn(broadcaster, "unsubscribe");
    const { url, controller } = await boot({ broadcaster });
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ subscribe: GUILD }));
    await nextMessage(ws); // initial snapshot
    ws.send(JSON.stringify({ unsubscribe: GUILD }));
    // Give the unsubscribe message a tick to be processed server-side.
    await new Promise((r) => setTimeout(r, 30));
    expect(unsubSpy).toHaveBeenCalledWith(BOT, GUILD, expect.any(Function));
    // After unsubscribe, a 'changed' must NOT deliver any further frame.
    let got = false;
    ws.on("message", () => (got = true));
    controller.emit("changed");
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(false);
    ws.close();
  });

  it("ignores a non-object JSON payload (e.g. null) without crashing the connection", async () => {
    const { url } = await boot({});
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise((r) => ws.once("open", r));
    // JSON.parse("null") is valid JSON but not a control message; the handler must
    // silently ignore it rather than throw on `msg.subscribe` (unhandled rejection).
    ws.send("null");
    ws.send("123");
    ws.send("not json{");
    // The socket must stay open and still serve a legitimate subscribe afterwards.
    ws.send(JSON.stringify({ subscribe: GUILD }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "state", guildId: GUILD });
    ws.close();
  });

  it("the revalidation interval emits {type:'revoked'} when canControl flips to false", async () => {
    const allow = { value: true };
    const { url } = await boot({ allow, revalidateMs: 20 });
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ subscribe: GUILD }));
    await nextMessage(ws); // the initial state snapshot
    allow.value = false; // membership revoked
    const revoked = await nextMessage(ws);
    expect(revoked).toMatchObject({ type: "revoked", guildId: GUILD });
    ws.close();
  });

  it("the close handler unsubscribes all guilds", async () => {
    const broadcaster = new GuildBroadcaster();
    const unsubSpy = vi.spyOn(broadcaster, "unsubscribe");
    const { url } = await boot({ broadcaster });
    const ws = new WebSocket(url, { headers: { origin: ORIGIN } });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ subscribe: GUILD }));
    await nextMessage(ws);
    ws.close();
    await closed(ws);
    // Give the server-side close handler a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(unsubSpy).toHaveBeenCalledWith(BOT, GUILD, expect.any(Function));
  });
});
