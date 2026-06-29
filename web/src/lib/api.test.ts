import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./api.js";

function mockOnce(ok: boolean, json: unknown, status = ok ? 200 : 400, statusText?: string) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText,
    headers: { get: () => null },
    json: async () => json,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("GET /api/me with credentials", async () => {
    const fn = mockOnce(true, { user: { id: "1" }, guilds: [] });
    const me = await api.me();
    expect(me.user.id).toBe("1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/me");
    expect((init as RequestInit).credentials).toBe("include");
  });
  it("play POSTs the input as JSON", async () => {
    const fn = mockOnce(true, { queued: { id: "i1", title: "X" } });
    await api.play("G1", "https://youtu.be/x", "C1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/play");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ input: "https://youtu.be/x", voiceChannelId: "C1" });
  });
  it("control hits the action route with no body or JSON content-type (avoids Fastify empty-body 400)", async () => {
    const fn = mockOnce(true, { ok: true });
    await api.control("G1", "pause");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/pause");
    const i = init as RequestInit;
    expect(i.method).toBe("POST");
    expect(i.body).toBeUndefined();
    expect(i.headers).toBeUndefined();
  });
  it("seek POSTs the positionMs as JSON", async () => {
    const fn = mockOnce(true, { ok: true });
    await api.seek("G1", 42000);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/seek");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ positionMs: 42000 });
  });
  it("pick POSTs the videoId (+ optional voice channel) as JSON", async () => {
    const fn = mockOnce(true, { queued: { id: "i1", title: "X" } });
    const r = await api.pick("G1", "vvvvvvvvvvv", "C1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/pick");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ videoId: "vvvvvvvvvvv", voiceChannelId: "C1" });
    expect(r.queued).toEqual({ id: "i1", title: "X" });
  });

  it("loadPlaylist POSTs the voiceChannelId (path-encodes the name)", async () => {
    const fn = mockOnce(true, { ok: true, queued: 3 });
    const r = await api.loadPlaylist("G1", "road trip", "C1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/playlists/road%20trip/load");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ voiceChannelId: "C1" });
    expect(r.queued).toBe(3);
  });
  it("loadPlaylist sends no voiceChannelId field when none is given", async () => {
    const fn = mockOnce(true, { ok: true, queued: 1 });
    await api.loadPlaylist("G1", "chill");
    const [, init] = fn.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ voiceChannelId: undefined });
  });

  it("remove POSTs the itemId to the queue/remove route", async () => {
    const fn = mockOnce(true, { ok: true });
    const r = await api.remove("G1", "item-9");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/queue/remove");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ itemId: "item-9" });
    expect(r.ok).toBe(true);
  });

  it("reorder POSTs itemId + toIndex to the queue/reorder route", async () => {
    const fn = mockOnce(true, { ok: true });
    await api.reorder("G1", "item-9", 3);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/queue/reorder");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ itemId: "item-9", toIndex: 3 });
  });

  it("getSettings GETs the settings route and returns the settings", async () => {
    const settings = { idleTimeoutSec: 300, crossfadeSec: 0, normalizeLoudness: false, repeat: "off", autoplay: false, autoplaySource: "radio", maxTrackDurationSec: 0 };
    const fn = mockOnce(true, { settings });
    const r = await api.getSettings("G1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/settings");
    // A GET carries no body and is not a POST.
    expect((init as RequestInit).method).toBeUndefined();
    expect(r.settings).toEqual(settings);
  });

  it("setSettings POSTs the patch (incl. new audio fields) and returns the persisted settings", async () => {
    const patch = { crossfadeSec: 8, normalizeLoudness: true, repeat: "all", autoplay: true, autoplaySource: "artist", maxTrackDurationSec: 7200 };
    const fn = mockOnce(true, { settings: { idleTimeoutSec: 300, ...patch } });
    const r = await api.setSettings("G1", patch as never);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/settings");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(patch);
    expect(r.settings).toMatchObject(patch);
  });

  it("voiceChannels GETs the route and returns channels + currentChannelId", async () => {
    const fn = mockOnce(true, { channels: [{ id: "C1", name: "General" }], currentChannelId: "C1" });
    const r = await api.voiceChannels("G1");
    const [url] = fn.mock.calls[0]!;
    expect(url).toBe("/api/guilds/G1/voice-channels");
    expect(r.channels).toEqual([{ id: "C1", name: "General" }]);
    expect(r.currentChannelId).toBe("C1");
  });

  it("throws ApiError with the status AND the body's error message on non-OK", async () => {
    mockOnce(false, { error: "forbidden" }, 403);
    await expect(api.state("G1")).rejects.toMatchObject({ status: 403, message: "forbidden" });
  });

  it("falls back to statusText when the non-OK body has no parseable JSON", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: { get: () => null },
      json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    });
    vi.stubGlobal("fetch", fn);
    await expect(api.state("G1")).rejects.toMatchObject({ status: 500, message: "Internal Server Error" });
  });

  it("falls back to statusText when the non-OK body has no error field", async () => {
    mockOnce(false, { somethingElse: true }, 404, "Not Found");
    await expect(api.state("G1")).rejects.toMatchObject({ status: 404, message: "Not Found" });
  });
  it("logout resolves on an empty 204 body without trying to parse JSON", async () => {
    // A 204 has no body; calling res.json() throws. The client must short-circuit.
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    });
    vi.stubGlobal("fetch", fn);
    await expect(api.logout()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith("/auth/logout", expect.objectContaining({ method: "POST" }));
  });
  it("short-circuits when content-length is 0", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === "content-length" ? "0" : null) },
      json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    });
    vi.stubGlobal("fetch", fn);
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
