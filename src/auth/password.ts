import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a supplied secret against the expected one.
 *
 * `timingSafeEqual` throws on unequal lengths, so the byte lengths are checked first and a
 * mismatch returns false directly. That early return leaks the LENGTH of the expected value and
 * nothing else — never a byte of its content — which is the standard, accepted trade.
 *
 * Used by the cookie console's `x-cookie-admin` gate. A naive `===` there would let an attacker
 * with a stable network path recover COOKIE_ADMIN_PASSWORD character by character from response
 * timing, and that password stands between the public panel and the bot's signed-in Google
 * session.
 */
export function verifyPassword(input: string, expected: string): boolean {
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
