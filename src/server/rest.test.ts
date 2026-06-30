import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerRest } from "./rest.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";

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
    enqueue: vi.fn(async (_meta: unknown, _requester: unknown) => ({ id: "i1" })),
    skip: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
    seek: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    reorder: vi.fn(async () => true),
    shuffle: vi.fn(async () => {}),
    jumpTo: vi.fn(async () => true),
    snapshot: vi.fn(() => ({
      current: null,
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    })) as ReturnType<typeof vi.fn>,
    settings: {
      idleTimeoutSec: 300,
      crossfadeSec: 0,
      normalizeLoudness: false,
      repeat: "off" as const,
      volume: 100,
      fx: "none" as const,
      commandChannelId: null as string | null,
    },
    updateSettings: vi.fn((patch: Record<string, unknown>) => ({
      idleTimeoutSec: 300,
      crossfadeSec: 0,
      normalizeLoudness: false,
      repeat: "off",
      volume: 100,
      fx: "none",
      ...patch,
    })),
    savePlaylist: vi.fn(async (_name: string) => {}),
    loadPlaylist: vi.fn(async (_name: string, _requester: unknown) => 2),
    listPlaylists: vi.fn(() => [{ name: "chill", trackCount: 3, savedAt: 1000 }]) as ReturnType<
      typeof vi.fn
    >,
    deletePlaylist: vi.fn(async (_name: string) => true),
  };
  const guild = {
    name: "Test Guild",
    members: { fetch: vi.fn(async (id: string) => ({ id })) },
    channels: {
      cache: new Map([
        [
          "VC1",
          {
            id: "VC1",
            name: "General Voice",
            type: 2,
            isVoiceBased: () => true,
            isTextBased: () => true,
          },
        ],
        [
          "TC1",
          {
            id: "TC1",
            name: "general",
            type: 0,
            isVoiceBased: () => false,
            isTextBased: () => true,
          },
        ],
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
  app.decorateRequest("session", null as never);
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
  it("play with a query that makes youtube.search throw a YtError returns 400 with the kind", async () => {
    const { app, controller, deps } = build(USER);
    controller.connectedChannelId = "C1";
    (deps.youtube.search as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new YtError(YtErrorKind.RateLimited, "yt-dlp: HTTP Error 429 …raw stderr…");
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "daft punk" },
    });
    expect(res.statusCode).toBe(400);
    // The KIND is returned, never the raw yt-dlp stderr message.
    expect(res.json().error).toBe(YtErrorKind.RateLimited);
    expect(JSON.stringify(res.json())).not.toContain("raw stderr");
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
  it("rejects 400 no_voice_channel when no channel is given and the bot is disconnected", async () => {
    // h.controller.connectedChannelId defaults to null, no voiceChannelId in payload.
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_voice_channel");
    expect(h.controller.enqueue).not.toHaveBeenCalled();
  });
  it("enqueues without a voiceChannelId when the bot is already connected", async () => {
    const { app, controller } = build(USER);
    controller.connectedChannelId = "C1";
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa" },
    });
    expect(res.statusCode).toBe(200);
    expect(controller.enqueue).toHaveBeenCalled();
    expect(controller.ensureConnected).not.toHaveBeenCalled();
  });
  it("non-admin requesting a different channel queues with moveSuppressed (no move)", async () => {
    const { app, controller } = build(USER); // not in adminIds
    controller.connectedChannelId = "C1";
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa", voiceChannelId: "C2" },
    });
    expect(res.statusCode).toBe(200);
    expect(controller.moveTo).not.toHaveBeenCalled();
    expect(controller.ensureConnected).not.toHaveBeenCalled();
    expect(controller.enqueue).toHaveBeenCalled();
    expect(res.json().queued).toMatchObject({ id: "i1" });
    expect(res.json().moveSuppressed).toEqual({ requested: "C2", actual: "C1" });
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
  it("pick resolves and enqueues a valid videoId (200)", async () => {
    const { app, controller, deps } = build(USER);
    controller.connectedChannelId = "C1"; // avoid the no_voice_channel 400
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/pick`,
      payload: { videoId: "aaaaaaaaaaa" },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.youtube.resolve).toHaveBeenCalledWith("aaaaaaaaaaa");
    const [enqueuedMeta] = controller.enqueue.mock.calls[0]!;
    expect(enqueuedMeta).toMatchObject({ videoId: "aaaaaaaaaaa" });
    expect(res.json().queued).toMatchObject({ id: "i1" });
  });
  it("enqueue rejecting with a YtError surfaces the message as a 400", async () => {
    const { app, controller } = build(USER);
    controller.connectedChannelId = "C1";
    controller.enqueue = vi.fn(async () => {
      throw new YtError(YtErrorKind.TooLong, "Too long — max 4h");
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Too long — max 4h");
  });
  it("enqueue throwing a non-YtError returns a sanitised 500 (no raw message leak)", async () => {
    const { app, controller } = build(USER);
    controller.connectedChannelId = "C1";
    controller.enqueue = vi.fn(async () => {
      throw new Error("disk full at /data/cache/xyz");
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("enqueue_failed");
    // The raw error message (with the filesystem path) must NOT reach the client.
    expect(JSON.stringify(res.json())).not.toContain("disk full");
  });
  it("resolve throwing a YtError returns 400 with the error kind", async () => {
    const { app } = build(USER, {
      youtube: {
        resolve: vi.fn(async () => {
          throw new YtError(YtErrorKind.Private, "private video");
        }),
        search: vi.fn(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/pick`,
      payload: { videoId: "aaaaaaaaaaa", voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("private");
  });
  it("resolve throwing a non-YtError returns 400 'resolve_failed'", async () => {
    const { app } = build(USER, {
      youtube: {
        resolve: vi.fn(async () => {
          throw new Error("boom");
        }),
        search: vi.fn(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/pick`,
      payload: { videoId: "aaaaaaaaaaa", voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("resolve_failed");
  });
  it("a failed voice connect returns 400 'voice_connect_failed' (not a 500)", async () => {
    const { app, controller } = build(USER);
    controller.ensureConnected = vi.fn(async () => {
      throw new Error("Unknown Channel");
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/play`,
      payload: { input: "https://youtu.be/aaaaaaaaaaa", voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("voice_connect_failed");
  });
  it("skip/pause/resume/stop call the controller", async () => {
    for (const action of ["skip", "pause", "resume", "stop"] as const) {
      const res = await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/${action}` });
      expect(res.statusCode).toBe(200);
    }
    expect(h.controller.skip).toHaveBeenCalled();
    expect(h.controller.pause).toHaveBeenCalled();
    expect(h.controller.resume).toHaveBeenCalled();
    expect(h.controller.stop).toHaveBeenCalled();
  });
  it("seek validates the position and calls the controller (rounded)", async () => {
    h.controller.snapshot.mockReturnValue({
      current: { meta: { durationSec: 120 } },
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/seek`,
      payload: { positionMs: 30000.7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(h.controller.seek).toHaveBeenCalledWith(30001);
  });
  it("seek rejects a negative position with 400 and no controller call", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/seek`,
      payload: { positionMs: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(h.controller.seek).not.toHaveBeenCalled();
  });
  it("seek beyond the track duration is rejected with 400", async () => {
    h.controller.snapshot.mockReturnValue({
      current: { meta: { durationSec: 10 } },
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/seek`,
      payload: { positionMs: 999999 },
    });
    expect(res.statusCode).toBe(400);
    expect(h.controller.seek).not.toHaveBeenCalled();
  });
  it("seek with nothing playing returns 409", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/seek`,
      payload: { positionMs: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(h.controller.seek).not.toHaveBeenCalled();
  });
  it("seek returns 200 with ok:false when the controller cannot seek", async () => {
    h.controller.snapshot.mockReturnValue({
      current: { meta: { durationSec: 120 } },
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    h.controller.seek.mockResolvedValue(false);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/seek`,
      payload: { positionMs: 30000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });
  it("seek returns 400 'seek failed' when the controller throws", async () => {
    h.controller.snapshot.mockReturnValue({
      current: { meta: { durationSec: 120 } },
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    h.controller.seek.mockRejectedValue(new Error("boom"));
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/seek`,
      payload: { positionMs: 30000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("seek failed");
  });
  it("seek on a live stream (durationSec:null) skips the upper-bound check", async () => {
    h.controller.snapshot.mockReturnValue({
      current: { meta: { durationSec: null } },
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/seek`,
      payload: { positionMs: 999999999 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(h.controller.seek).toHaveBeenCalledWith(999999999);
  });
  it("queue/remove and reorder use the itemId (200)", async () => {
    const r1 = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/remove`,
      payload: { itemId: "i9" },
    });
    expect(r1.statusCode).toBe(200);
    expect(h.controller.remove).toHaveBeenCalledWith("i9");
    const r2 = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/reorder`,
      payload: { itemId: "i9", toIndex: 0 },
    });
    expect(r2.statusCode).toBe(200);
    expect(h.controller.reorder).toHaveBeenCalledWith("i9", 0);
  });
  it("queue/remove with an empty itemId returns 400 and does not call remove", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/remove`,
      payload: { itemId: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(h.controller.remove).not.toHaveBeenCalled();
  });
  it("queue/reorder with a missing itemId returns 400 and does not call reorder", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/reorder`,
      payload: { toIndex: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(h.controller.reorder).not.toHaveBeenCalled();
  });
  it("queue/reorder with a negative toIndex returns 400 and does not call reorder", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/reorder`,
      payload: { itemId: "i9", toIndex: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(h.controller.reorder).not.toHaveBeenCalled();
  });
  it("queue/reorder with a fractional toIndex returns 400 and does not call reorder", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/queue/reorder`,
      payload: { itemId: "i9", toIndex: 1.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(h.controller.reorder).not.toHaveBeenCalled();
  });
  it("shuffle forwards to the controller (200) and is auth-gated", async () => {
    const r = await h.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/shuffle` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(h.controller.shuffle).toHaveBeenCalledTimes(1);

    const anon = build(null);
    const r401 = await anon.app.inject({ method: "POST", url: `/api/guilds/${GUILD}/shuffle` });
    expect(r401.statusCode).toBe(401);
    expect(anon.controller.shuffle).not.toHaveBeenCalled();
  });
  it("jump forwards the itemId to jumpTo (200) and echoes ok", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/jump`,
      payload: { itemId: "i9" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(h.controller.jumpTo).toHaveBeenCalledWith("i9");
  });
  it("jump with a missing itemId returns 400 and does not call jumpTo", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/jump`,
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(h.controller.jumpTo).not.toHaveBeenCalled();
  });
  it("jump is auth-gated (401 when not logged in)", async () => {
    const anon = build(null);
    const r = await anon.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/jump`,
      payload: { itemId: "i9" },
    });
    expect(r.statusCode).toBe(401);
    expect(anon.controller.jumpTo).not.toHaveBeenCalled();
  });
  it("GET /api/guilds/:id/state returns the full snapshot payload shape", async () => {
    h.controller.snapshot.mockReturnValue({
      current: null,
      upcoming: [],
      history: [],
      paused: false,
      idleTimeoutSec: 300,
      crossfadeSec: 0,
      normalizeLoudness: false,
      repeat: "off",
      autoplay: true,
      autoplaySource: "radio",
      maxTrackDurationSec: 0,
    });
    const res = await h.app.inject({ method: "GET", url: `/api/guilds/${GUILD}/state` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      paused: false,
      repeat: "off",
      autoplay: true,
      idleTimeoutSec: 300,
    });
  });

  it("GET /api/guilds/:id/settings returns the controller's settings", async () => {
    const res = await h.app.inject({ method: "GET", url: `/api/guilds/${GUILD}/settings` });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({
      idleTimeoutSec: 300,
      crossfadeSec: 0,
      normalizeLoudness: false,
      repeat: "off",
      volume: 100,
      fx: "none",
    });
  });

  it("GET /api/guilds/:id/settings is gated by control auth (401 when not logged in)", async () => {
    const { app } = build(null);
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/settings` });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/guilds/:id/settings forwards the patch to updateSettings and echoes the result", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/settings`,
      payload: { crossfadeSec: 5, repeat: "all", normalizeLoudness: true },
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.updateSettings).toHaveBeenCalledWith({
      crossfadeSec: 5,
      repeat: "all",
      normalizeLoudness: true,
    });
    expect(res.json().settings).toMatchObject({
      crossfadeSec: 5,
      repeat: "all",
      normalizeLoudness: true,
    });
  });

  it("POST /api/guilds/:id/settings forwards a volume + fx patch and echoes the result", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/settings`,
      payload: { volume: 150, fx: "bassboost" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.updateSettings).toHaveBeenCalledWith({ volume: 150, fx: "bassboost" });
    expect(res.json().settings).toMatchObject({ volume: 150, fx: "bassboost" });
  });

  it("POST /api/guilds/:id/settings forwards a commandChannelId patch (set and clear)", async () => {
    const set = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/settings`,
      payload: { commandChannelId: "TC1" },
    });
    expect(set.statusCode).toBe(200);
    expect(h.controller.updateSettings).toHaveBeenCalledWith({ commandChannelId: "TC1" });
    expect(set.json().settings).toMatchObject({ commandChannelId: "TC1" });

    const clear = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/settings`,
      payload: { commandChannelId: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(h.controller.updateSettings).toHaveBeenCalledWith({ commandChannelId: null });
    expect(clear.json().settings).toMatchObject({ commandChannelId: null });
  });

  it("POST /api/guilds/:id/settings forwards an idle-timeout patch (clamping is the controller's job)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/settings`,
      payload: { idleTimeoutSec: 600 },
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.updateSettings).toHaveBeenCalledWith({ idleTimeoutSec: 600 });
    expect(res.json().settings).toMatchObject({ idleTimeoutSec: 600 });
  });

  it("POST /api/guilds/:id/settings is gated by control auth (401 when not logged in)", async () => {
    const { app } = build(null);
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/settings`,
      payload: { crossfadeSec: 2 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/guilds/:id/settings is gated by control auth (403 for a non-member)", async () => {
    const guild = {
      members: {
        fetch: vi.fn(async () => {
          throw new Error("Unknown Member");
        }),
      },
    };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/settings`,
      payload: { idleTimeoutSec: 60 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /api/guilds/:id/voice-channels returns only voice channels for a member", async () => {
    const res = await h.app.inject({ method: "GET", url: `/api/guilds/${GUILD}/voice-channels` });
    expect(res.statusCode).toBe(200);
    const { channels, currentChannelId } = res.json() as {
      channels: { id: string; name: string }[];
      currentChannelId: string | null;
    };
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: "VC1", name: "General Voice" });
    // No voice-state cache wired in this fixture -> null.
    expect(currentChannelId).toBeNull();
  });

  it("GET /api/guilds/:id/voice-channels reports the channel the user is connected to", async () => {
    const guild = {
      name: "Test Guild",
      members: { fetch: vi.fn(async (id: string) => ({ id })) },
      channels: {
        cache: new Map([
          ["VC1", { id: "VC1", name: "General Voice", type: 2, isVoiceBased: () => true }],
        ]),
      },
      voiceStates: { cache: new Map([[USER, { channelId: "VC1" }]]) },
    };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/voice-channels` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { currentChannelId: string | null }).currentChannelId).toBe("VC1");
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

  it("GET /api/guilds/:id/text-channels returns only text (non-voice) channels for a member", async () => {
    const res = await h.app.inject({ method: "GET", url: `/api/guilds/${GUILD}/text-channels` });
    expect(res.statusCode).toBe(200);
    const { channels } = res.json() as { channels: { id: string; name: string }[] };
    // The voice channel (VC1) is text-based too in v14, but it is excluded — only TC1.
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: "TC1", name: "general" });
  });

  it("GET /api/guilds/:id/text-channels returns 403 for a non-member", async () => {
    const guild = {
      name: "Test Guild",
      members: {
        fetch: vi.fn(async () => {
          throw new Error("Unknown Member");
        }),
      },
      channels: {
        cache: new Map([
          [
            "TC1",
            {
              id: "TC1",
              name: "general",
              type: 0,
              isVoiceBased: () => false,
              isTextBased: () => true,
            },
          ],
        ]),
      },
    };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/text-channels` });
    expect(res.statusCode).toBe(403);
  });

  it("GET /api/guilds/:id/text-channels returns 401 when not logged in", async () => {
    const { app } = build(null);
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/text-channels` });
    expect(res.statusCode).toBe(401);
  });
});

describe("REST playlists", () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build(USER);
  });

  it("GET /playlists returns the controller's summaries", async () => {
    const res = await h.app.inject({ method: "GET", url: `/api/guilds/${GUILD}/playlists` });
    expect(res.statusCode).toBe(200);
    expect(res.json().playlists).toEqual([{ name: "chill", trackCount: 3, savedAt: 1000 }]);
    expect(h.controller.listPlaylists).toHaveBeenCalled();
  });

  it("POST /playlists saves the named playlist and echoes the new list", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists`,
      payload: { name: "road trip" },
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.savePlaylist).toHaveBeenCalledWith("road trip");
    expect(res.json()).toMatchObject({ ok: true });
    expect(Array.isArray(res.json().playlists)).toBe(true);
  });

  it("POST /playlists trims the name and rejects a blank one with 400", async () => {
    const r1 = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists`,
      payload: { name: "  spaced  " },
    });
    expect(r1.statusCode).toBe(200);
    expect(h.controller.savePlaylist).toHaveBeenCalledWith("spaced");

    const r2 = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists`,
      payload: { name: "   " },
    });
    expect(r2.statusCode).toBe(400);
  });

  it("POST /playlists surfaces an empty-queue save error as 400", async () => {
    h.controller.savePlaylist = vi.fn(async () => {
      throw new Error("cannot save an empty playlist");
    });
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists`,
      payload: { name: "nothing" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot save an empty playlist");
  });

  it("POST /playlists maps an I/O error to a sanitised 500 (no fs path leak)", async () => {
    h.controller.savePlaylist = vi.fn(async () => {
      throw new Error("ENOSPC: no space left on device, write '/data/cache/playlists.json.tmp'");
    });
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists`,
      payload: { name: "road trip" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("could not save playlist");
    // The raw fs error (with the server filesystem path) must NOT reach the client.
    expect(JSON.stringify(res.json())).not.toContain("/data/cache");
  });

  it("POST /playlists/:name/load connects to the given channel, then enqueues + reports the count", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/road%20trip/load`,
      payload: { voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: 2 });
    // The bot was connected to the requested channel BEFORE loading (else the tracks
    // would queue into the void), mirroring play/pick's enqueue connection logic.
    expect(h.controller.ensureConnected).toHaveBeenCalledWith("C1");
    const [name, requester] = h.controller.loadPlaylist.mock.calls[0]!;
    expect(name).toBe("road trip"); // URL-decoded
    expect(requester).toMatchObject({ discordUserId: USER, source: "web" });
  });

  it("POST /playlists/:name/load handles a name containing a literal '%' (no double-decode 500)", async () => {
    // "50% off" is URL-encoded by the client as "50%25off"; find-my-way decodes it once to
    // "50%off". A second decodeURIComponent('50%off') would throw URIError -> 500. Assert we
    // pass the once-decoded name straight through and the request succeeds.
    const { app, controller } = build(USER);
    controller.connectedChannelId = "C1";
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/50%25off/load`,
    });
    expect(res.statusCode).toBe(200);
    const [name] = controller.loadPlaylist.mock.calls[0]!;
    expect(name).toBe("50%off");
  });

  it("DELETE /playlists/:name handles a name containing a literal '%' (no double-decode 500)", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/guilds/${GUILD}/playlists/50%25off`,
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.deletePlaylist).toHaveBeenCalledWith("50%off");
  });

  it("POST /playlists/:name/load 404s when the playlist doesn't exist (count 0)", async () => {
    h.controller.connectedChannelId = "C1"; // already connected: skip the no_voice_channel guard
    h.controller.loadPlaylist = vi.fn(async () => 0);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/ghost/load`,
      payload: { voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /playlists/:name/load 400 no_voice_channel when no channel given and bot is disconnected", async () => {
    // h.controller.connectedChannelId defaults to null, no voiceChannelId in payload.
    const res = await h.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/road%20trip/load`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_voice_channel");
    expect(h.controller.loadPlaylist).not.toHaveBeenCalled();
  });

  it("POST /playlists/:name/load works without a channel when the bot is already connected", async () => {
    const { app, controller } = build(USER);
    controller.connectedChannelId = "C1";
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/road%20trip/load`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: 2 });
    expect(controller.loadPlaylist).toHaveBeenCalled();
    expect(controller.ensureConnected).not.toHaveBeenCalled();
    expect(controller.moveTo).not.toHaveBeenCalled();
  });

  it("POST /playlists/:name/load admin moveTo when connected to a different channel", async () => {
    const { app, controller } = build(USER, { adminIds: new Set([USER]) });
    controller.connectedChannelId = "C1";
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/road%20trip/load`,
      payload: { voiceChannelId: "C2" },
    });
    expect(res.statusCode).toBe(200);
    expect(controller.moveTo).toHaveBeenCalledWith("C2");
    expect(controller.ensureConnected).not.toHaveBeenCalled();
  });

  it("POST /playlists/:name/load surfaces a failed voice connect as 400 voice_connect_failed", async () => {
    const { app, controller } = build(USER);
    controller.ensureConnected = vi.fn(async () => {
      throw new Error("Unknown Channel");
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/road%20trip/load`,
      payload: { voiceChannelId: "C1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("voice_connect_failed");
    expect(controller.loadPlaylist).not.toHaveBeenCalled();
  });

  it("DELETE /playlists/:name deletes and echoes the new list", async () => {
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/guilds/${GUILD}/playlists/chill`,
    });
    expect(res.statusCode).toBe(200);
    expect(h.controller.deletePlaylist).toHaveBeenCalledWith("chill");
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("DELETE /playlists/:name 404s when the playlist doesn't exist", async () => {
    h.controller.deletePlaylist = vi.fn(async () => false);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/guilds/${GUILD}/playlists/ghost`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("all playlist endpoints are auth-gated (401 when not logged in)", async () => {
    const anon = build(null);
    const get = await anon.app.inject({ method: "GET", url: `/api/guilds/${GUILD}/playlists` });
    const post = await anon.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists`,
      payload: { name: "x" },
    });
    const load = await anon.app.inject({
      method: "POST",
      url: `/api/guilds/${GUILD}/playlists/x/load`,
    });
    const del = await anon.app.inject({
      method: "DELETE",
      url: `/api/guilds/${GUILD}/playlists/x`,
    });
    expect(get.statusCode).toBe(401);
    expect(post.statusCode).toBe(401);
    expect(load.statusCode).toBe(401);
    expect(del.statusCode).toBe(401);
    expect(anon.controller.savePlaylist).not.toHaveBeenCalled();
    expect(anon.controller.loadPlaylist).not.toHaveBeenCalled();
    expect(anon.controller.deletePlaylist).not.toHaveBeenCalled();
  });

  it("playlist endpoints are gated by control auth (403 for a non-member)", async () => {
    const guild = {
      members: {
        fetch: vi.fn(async () => {
          throw new Error("Unknown Member");
        }),
      },
    };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/playlists` });
    expect(res.statusCode).toBe(403);
  });
});

describe("REST lyrics", () => {
  const current = {
    id: "i1",
    addedAt: 0,
    positionMs: 0,
    durationMs: 1000,
    audio: null,
    meta: meta("aaaaaaaaaaa", "Hello"),
    requester: { discordUserId: USER, displayName: "dj", avatarUrl: "", source: "web" },
  };

  it("returns the current track's lyrics from the lyrics fetcher", async () => {
    const lyrics = vi.fn(async () => ({ lyrics: "la la", source: "lyrics.ovh" }));
    const { app, controller } = build(USER, { lyrics });
    controller.snapshot.mockReturnValue({
      current,
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/lyrics` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lyrics: "la la", source: "lyrics.ovh" });
    expect(lyrics).toHaveBeenCalledWith(current.meta);
  });

  it("returns { lyrics: null } with 200 when nothing is playing", async () => {
    const lyrics = vi.fn();
    const { app, controller } = build(USER, { lyrics });
    controller.snapshot.mockReturnValue({
      current: null,
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/lyrics` });
    expect(res.statusCode).toBe(200);
    expect(res.json().lyrics).toBeNull();
    expect(lyrics).not.toHaveBeenCalled();
  });

  it("returns { lyrics: null } when the fetcher finds none", async () => {
    const lyrics = vi.fn(async () => ({ lyrics: null, source: "lyrics.ovh" }));
    const { app, controller } = build(USER, { lyrics });
    controller.snapshot.mockReturnValue({
      current,
      upcoming: [],
      history: [],
      idleTimeoutSec: 300,
    });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/lyrics` });
    expect(res.statusCode).toBe(200);
    expect(res.json().lyrics).toBeNull();
  });

  it("requires control (403 for non-member)", async () => {
    const guild = {
      members: {
        fetch: vi.fn(async () => {
          throw new Error("Unknown Member");
        }),
      },
    };
    const { app } = build(USER, { client: { guilds: { cache: new Map([[GUILD, guild]]) } } });
    const res = await app.inject({ method: "GET", url: `/api/guilds/${GUILD}/lyrics` });
    expect(res.statusCode).toBe(403);
  });
});
