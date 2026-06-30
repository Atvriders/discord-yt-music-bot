import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeCode, fetchIdentity, revokeToken } from "./oauth.js";

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
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=CODE");
    // Lock in the security-critical / required fields so a future change that drops them
    // from the URLSearchParams body (breaking every real exchange) fails the test.
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=sec");
    expect(body).toContain("redirect_uri=https%3A%2F%2Fm%2Fcb");
  });
  it("throws when the token endpoint fails", async () => {
    mockFetch([{ ok: false, json: {} }]);
    await expect(exchangeCode(cfg, "CODE")).rejects.toThrow();
  });
  // Drive each insufficient-scope branch independently so a regression that flips the &&
  // (both required) to || (either suffices) is caught. "identify guilds" is the only accepted
  // value; everything else must reject.
  it.each([
    [""], // empty
    ["identify"], // guilds absent
    ["guilds"], // identify absent
    ["email"], // unrelated
  ])("throws when the granted scope is %j (insufficient)", async (scope) => {
    mockFetch([
      {
        ok: true,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 1,
          refresh_token: "RT",
          scope,
        },
      },
    ]);
    await expect(exchangeCode(cfg, "CODE")).rejects.toThrow(/scope/i);
  });
});

describe("fetchIdentity", () => {
  it("returns the user on success", async () => {
    mockFetch([{ ok: true, json: { id: "1", username: "u", global_name: "U", avatar: null } }]);
    const me = await fetchIdentity("AT");
    expect(me.id).toBe("1");
  });
  it("throws when the identity endpoint fails", async () => {
    mockFetch([{ ok: false, json: {} }]);
    await expect(fetchIdentity("AT")).rejects.toThrow();
  });
});

describe("OAuth fetch timeouts", () => {
  it("attaches an abort signal to exchangeCode, fetchIdentity and revokeToken", async () => {
    const fn = mockFetch([
      {
        ok: true,
        json: {
          access_token: "AT",
          token_type: "Bearer",
          expires_in: 1,
          refresh_token: "RT",
          scope: "identify guilds",
        },
      },
      { ok: true, json: { id: "1", username: "u", avatar: null } },
      { ok: true, json: {} },
    ]);
    await exchangeCode(cfg, "CODE");
    await fetchIdentity("AT");
    await revokeToken(cfg, "AT");
    // Every outbound OAuth call must carry an AbortSignal so a hung Discord endpoint
    // cannot tie up a request/worker indefinitely.
    for (const call of fn.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
