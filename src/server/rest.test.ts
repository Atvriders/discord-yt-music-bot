import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerRest } from "./rest.js";

const USER = "123456789012345678";
const GUILD = "234567890123456789";
const meta = (id: string, title = id) => ({
  videoId: id,
  title,
  channel: "c",
  durationSec: 1,
  isLive: false,
  thumbnailUrl: null,
});

function build(sessionUserId: string | null, depOverrides: Record<string, unknown> = {}) {
  const controller = {
    ensureConnected: vi.fn(async () => {}),
    moveTo: vi.fn(async () => {}),
    connectedChannelId: null as string | null,
    enqueue: vi.fn(async () => ({ id: "i1" })),
    skip: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    reorder: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
  };
  const guild = {
    name: "Test Guild",
    members: { fetch: vi.fn(async (id: string) => ({ id })) },
    channels: {
      cache: new Map([
        ["VC1", { id: "VC1", name: "General Voice", type: 2, isVoiceBased: () => true }],
        ["TC1", { id: "TC1", name: "general", type: 0, isVoiceBased: () => false }],
      ]),
    },
  };
  const deps = {
    hub: { get: vi.fn(() => controller) },
    youtube: {
      resolve: vi.fn(async (id: string) => meta(id, "Song")),
      search: vi.fn(async () => [meta("aaaaaaaaaaa", "A")]),
    },
    client: { guilds: { cache: new Map([[GUILD, guild]]) } },
    adminIds: new Set<string>(),
    searchLimit: 5,
    ...depOverrides,
  };
  const app = Fastify();
  // emulate the session: a preHandler that sets request.session from a header
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req) => {
    (req as { session: unknown }).session = sessionUserId ? { userId: sessionUserId } : {};
  });
  registerRest(app, deps as never);
  return { app, controller, deps };
}

describe("REST auth gating", () => {
  it("401 when not logged in", async () => {
    const { app } = build(null);
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/state` });
    expect(res.statusCode).toBe(401);
  });
  it("403 when logged in but not a guild member / admin", async () => {
    const guild = {
      members: {
        fetch: vi.fn(async () => {
          throw new Error("Unknown Member");
        }),
      },
    };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({ method: "POST", url: `/api/guilds/${GUILD}/skip` });
    expect(res.statusCode).toBe(403);
  });
});

describe("REST actions", () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build(USER);
  });

  it("GET /api/me returns the user and bot-verified guilds", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(USER);
    expect(Array.isArray(res.json().guilds)).toBe(true);
    expect(res.json().guilds[0]).toMatchObject({ id: GUILD, name: "Test Guild" });
  });
  it("play with a URL resolves + enqueues (attributed to the web user)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa", voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.ensureConnected).toHaveBeenCalledWith("C1");
    const [, requester] = h.controller.enqueue.mock.calls[0]!;
    expect(requester).toMatchObject({ discordUserId: USER, source: "web" });
  });
  it("play with a query returns candidates (no enqueue)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "daft punk" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates).toHaveLength(1);
    expect(h.controller.enqueue).not.toHaveBeenCalled();
  });
  it("play with a non-YouTube URL is rejected (400), no resolve", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://vimeo.com/1" },
    });
    expect(res.statusCode).toBe(400);
    expect(h.deps.youtube.resolve).not.toHaveBeenCalled();
  });

  it("admin posting play with a different voiceChannelId while connected triggers moveTo", async () => {
    // Rebuild with an admin user and a controller that reports it's already connected to C1.
    const { app, controller } = build(USER, { adminIds: new Set([USER]) });
    controller.connectedChannelId = "C1";
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa", voiceChannelId: "C2" },
    });
    expect(res.statusCode).toBe(200);
    expect(controller.moveTo).toHaveBeenCalledWith("C2");
    expect(controller.ensureConnected).not.toHaveBeenCalled();
  });
  it("pick rejects a malformed videoId with 400 and no resolve", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/pick`,
      payload: { videoId: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(h.deps.youtube.resolve).not.toHaveBeenCalled();
  });
  it("skip/pause/resume/stop call the controller", async () => {
    for (const action of ["skip", "pause", "resume", "stop"] as const) {
      const res = await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/${action}` });
      expect(res.statusCode).toBe(200);
    }
    expect(h.controller.skip).toHaveBeenCalled();
    expect(h.controller.stop).toHaveBeenCalled();
  });
  it("queue/remove and reorder use the itemId", async () => {
    await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/remove`,
      payload: { itemId: "i9" },
    });
    expect(h.controller.remove).toHaveBeenCalledWith("i9");
    await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/reorder`,
      payload: { itemId: "i9", toIndex: 0 },
    });
    expect(h.controller.reorder).toHaveBeenCalledWith("i9", 0);
  });
  it("GET /api/guilds/:id/voice-channels returns only voice channels for a member", async () => {
    const res = await h.app.inject({ method: "GET", url: `/api/guilds/${GUILD}/voice-channels` });
    expect(res.statusCode).toBe(200);
    const { channels } = res.json() as { channels: { id: string; name: string }[] };
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: "VC1", name: "General Voice" });
  });
  it("GET /api/guilds/:id/voice-channels returns 403 for a non-member", async () => {
    const guild = {
      name: "Test Guild",
      members: {
        fetch: vi.fn(async () => {
          throw new Error("Unknown Member");
        }),
      },
      channels: {
        cache: new Map([
          ["VC1", { id: "VC1", name: "General Voice", type: 2, isVoiceBased: () => true }],
        ]),
      },
    };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/voice-channels` });
    expect(res.statusCode).toBe(403);
  });
});
