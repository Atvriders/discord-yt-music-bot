import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError } from "./api.js";

function mockOnce(ok: boolean, json: unknown, status = ok ? 200 : 400) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
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
  it("throws ApiError with the status on non-OK", async () => {
    mockOnce(false, { error: "forbidden" }, 403);
    await expect(api.state("G1")).rejects.toMatchObject({ status: 403 });
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
