import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError } from "./api.js";

function mockOnce(ok: boolean, json: unknown, status = ok ? 200 : 400) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => json });
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
  it("control hits the action route", async () => {
    const fn = mockOnce(true, { ok: true });
    await api.control("G1", "skip");
    expect(fn.mock.calls[0]![0]).toBe("/api/guilds/G1/skip");
  });
  it("throws ApiError with the status on non-OK", async () => {
    mockOnce(false, { error: "forbidden" }, 403);
    await expect(api.state("G1")).rejects.toMatchObject({ status: 403 });
  });
});
