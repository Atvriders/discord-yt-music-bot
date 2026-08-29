import { describe, it, expect } from "vitest";
import { verifyPassword } from "./password.js";

describe("verifyPassword", () => {
  it("accepts an exact match", () => {
    expect(verifyPassword("correct horse battery staple", "correct horse battery staple")).toBe(
      true,
    );
  });

  it("rejects a wrong value of the same length", () => {
    expect(verifyPassword("aaaaaaaa", "bbbbbbbb")).toBe(false);
  });

  it("rejects on a length mismatch instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths; the guard has to turn that into a plain false,
    // or every short/long attempt would 500 the route instead of 403-ing it.
    expect(verifyPassword("short", "a much longer password")).toBe(false);
    expect(verifyPassword("a much longer password", "short")).toBe(false);
  });

  it("rejects an empty supplied value", () => {
    // The header-missing case arrives here as "" — it must never match a real password.
    expect(verifyPassword("", "secret")).toBe(false);
  });

  it("is case- and whitespace-sensitive", () => {
    expect(verifyPassword("Secret", "secret")).toBe(false);
    expect(verifyPassword("secret ", "secret")).toBe(false);
  });

  it("compares by BYTES, so multi-byte input cannot alias a shorter password", () => {
    // "é" is two bytes in UTF-8. A naive length check on JS string units would call these equal
    // in length and hand the comparison to timingSafeEqual, which would throw.
    expect(verifyPassword("é", "ab")).toBe(false);
    expect(verifyPassword("café", "café")).toBe(true);
  });
});
