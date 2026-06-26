import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeCode, fetchIdentity } from "./oauth.js";

const cfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://m/cb" } as never;

function mockFetch(spec: Array<{ ok: boolean; json: unknown }>) {
  const fn = vi.fn();
  spec.forEach((s) => fn.mockResolvedValueOnce({ ok: s.ok, json: async () => s.json }));
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("exchangeCode", () => {
  it("posts the code and returns the token when scope is sufficient", async () => {
    const fn = mockFetch([
      {
        ok: true,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 604800,
          refresh_token: "RT",
          scope: "identify guilds",
        },
      },
    ]);
    const tok = await exchangeCode(cfg, "CODE");
    expect(tok.access_token).toBe("AT");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("https://discord.com/api/oauth2/token");
    expect((init as RequestInit).method).toBe("POST");
    expect(String((init as RequestInit).body)).toContain("grant_type=authorization_code");
    expect(String((init as RequestInit).body)).toContain("code=CODE");
  });
  it("throws when the token endpoint fails", async () => {
    mockFetch([{ ok: false, json: {} }]);
    await expect(exchangeCode(cfg, "CODE")).rejects.toThrow();
  });
  it("throws when the granted scope is missing identify or guilds", async () => {
    mockFetch([
      {
        ok: true,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 1,
          refresh_token: "RT",
          scope: "identify",
        },
      },
    ]);
    await expect(exchangeCode(cfg, "CODE")).rejects.toThrow(/scope/i);
  });
});

describe("fetchIdentity", () => {
  it("returns the user on success and throws on failure", async () => {
    mockFetch([{ ok: true, json: { id: "1", username: "u", global_name: "U", avatar: null } }]);
    const me = await fetchIdentity("AT");
    expect(me.id).toBe("1");
    mockFetch([{ ok: false, json: {} }]);
    await expect(fetchIdentity("AT")).rejects.toThrow();
  });
});
