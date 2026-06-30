import { describe, it, expect } from "vitest";
import { generateState, verifyState, buildAuthorizeUrl, avatarUrl } from "./oauth.js";

describe("oauth state + urls", () => {
  it("generates distinct, urlsafe states", () => {
    const a = generateState(),
      b = generateState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("verifyState is true only for an exact match", () => {
    const s = generateState();
    expect(verifyState(s, s)).toBe(true);
    expect(verifyState(s, generateState())).toBe(false);
    expect(verifyState("", s)).toBe(false);
    expect(verifyState(s, undefined)).toBe(false);
  });
  it("verifyState returns false (not throw) for a multibyte same-JS-length input", () => {
    // 43 '€' chars: same JS .length as a 43-char base64url state but 129 UTF-8 bytes.
    // A naive string-length guard would let this reach timingSafeEqual and throw RangeError.
    const expected = "a".repeat(43);
    const received = "€".repeat(43);
    expect(received.length).toBe(expected.length);
    expect(() => verifyState(received, expected)).not.toThrow();
    expect(verifyState(received, expected)).toBe(false);
  });
  it("buildAuthorizeUrl includes the required params", () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://m/cb" } as never, "STATE"),
    );
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe("identify guilds");
    expect(url.searchParams.get("redirect_uri")).toBe("https://m/cb");
    expect(url.searchParams.get("state")).toBe("STATE");
    // prompt=none avoids re-prompting consent on every login; pin it so a silent
    // removal/change is caught.
    expect(url.searchParams.get("prompt")).toBe("none");
  });
  it("avatarUrl builds a CDN url or a default", () => {
    expect(avatarUrl({ id: "1", avatar: "abc" })).toContain("/avatars/1/abc.png");
    expect(avatarUrl({ id: "1", avatar: "a_xyz" })).toContain(".gif");
    // id='22' >> 22 = 0, so index 0 regardless of the modulus — assert the exact index.
    expect(avatarUrl({ id: "22", avatar: null })).toContain("/embed/avatars/0.png");
    // A NON-zero shifted value exercises the % 6n modulus: 20971520 >> 22 = 5, 5 % 6 = 5.
    // (5 % 5 = 0 under the old 5-avatar formula, so this distinguishes the two.)
    expect(avatarUrl({ id: "20971520", avatar: null })).toContain("/embed/avatars/5.png");
  });
});
