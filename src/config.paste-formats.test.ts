import { describe, it, expect } from "vitest";
import { toNetscapeCookies } from "./config.js";
import { countCookieLines, hasAuthCookie } from "./cookies/index.js";

/**
 * Every shape an operator actually arrives with. The bar for each case is not "it produced some
 * text" but the two things that decide whether the paste works:
 *
 *   countCookieLines(jar) > 0  — the console will accept it rather than say "no cookies found"
 *   every non-comment line has exactly 7 tab-separated fields — yt-dlp's cookie loader raises on
 *   the FIRST malformed line and then refuses the ENTIRE file, so a jar that is 90% right is
 *   worth exactly as much as one that is 0% right.
 */

const SID = "g.a000abcdefghijklmnopqrstuvwxyz0123456789";

/** Assert the jar is something yt-dlp will actually load: header + only well-formed lines. */
function expectLoadable(jar: string): void {
  const lines = jar.split("\n").filter((l) => l.trim() !== "");
  expect(lines[0]).toBe("# Netscape HTTP Cookie File");
  for (const line of lines.slice(1)) {
    // `#HttpOnly_` is a cookie line, not a comment; anything else starting with # would be one.
    expect(line.startsWith("#") && !line.startsWith("#HttpOnly_")).toBe(false);
    expect(line.split("\t")).toHaveLength(7);
  }
  expect(countCookieLines(jar)).toBeGreaterThan(0);
}

describe("paste format: a real cookies.txt export", () => {
  it("passes tab-separated Netscape through, HttpOnly lines included", () => {
    const jar = toNetscapeCookies(
      [
        "# Netscape HTTP Cookie File",
        ".youtube.com\tTRUE\t/\tTRUE\t2000000000\tYSC\tabc",
        `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\t${SID}`,
      ].join("\n"),
    );
    expectLoadable(jar);
    expect(countCookieLines(jar)).toBe(2);
    expect(hasAuthCookie(jar)).toBe(true);
  });

  it("adds the header when the export was pasted without it", () => {
    const jar = toNetscapeCookies(`.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\t${SID}`);
    expectLoadable(jar);
    expect(hasAuthCookie(jar)).toBe(true);
  });

  it("does not double up the header", () => {
    const jar = toNetscapeCookies(
      `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\t${SID}`,
    );
    expect(jar.match(/# Netscape HTTP Cookie File/g)).toHaveLength(1);
  });
});

describe("paste format: a cookies.txt whose TABS were eaten", () => {
  // Copying an export through a viewer, a chat window or a textarea routinely turns the tabs
  // into spaces. It looks perfect to a human and is unparseable to yt-dlp — and it used to sail
  // through untouched, producing a jar that made EVERY extraction fail with "unknown".
  it("repairs space-separated columns back into tabs", () => {
    const jar = toNetscapeCookies(
      [
        "# Netscape HTTP Cookie File",
        `.youtube.com TRUE / TRUE 2000000000 SID ${SID}`,
        ".youtube.com TRUE / TRUE 2000000000 YSC abc",
      ].join("\n"),
    );
    expectLoadable(jar);
    expect(countCookieLines(jar)).toBe(2);
    expect(hasAuthCookie(jar)).toBe(true);
  });

  it("keeps a value that itself contains spaces intact", () => {
    // Only the first six fields are tokens; everything after them is the value.
    const jar = toNetscapeCookies(".youtube.com TRUE / TRUE 2000000000 PREF f1=1 f6=9 tz=UTC");
    expectLoadable(jar);
    expect(jar).toContain("\tPREF\tf1=1 f6=9 tz=UTC");
  });

  it("DROPS a line it cannot repair rather than poisoning the whole file", () => {
    const jar = toNetscapeCookies(
      [
        "# Netscape HTTP Cookie File",
        `.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\t${SID}`,
        "this line is prose someone pasted by accident",
        ".youtube.com\tTRUE\t/\tTRUE", // truncated mid-line
      ].join("\n"),
    );
    // yt-dlp refuses the ENTIRE file over one bad line, so salvaging the good ones is the
    // difference between a working session and a bot that cannot play anything at all.
    expectLoadable(jar);
    expect(countCookieLines(jar)).toBe(1);
    expect(hasAuthCookie(jar)).toBe(true);
  });
});

describe("paste format: a browser Cookie: request header", () => {
  it("converts one header line, with or without the 'Cookie:' label", () => {
    for (const text of [
      `YSC=abc; __Secure-1PSID=${SID}; HSID=Hval`,
      `cookie: YSC=abc; __Secure-1PSID=${SID}; HSID=Hval`,
      `Cookie:   YSC=abc; __Secure-1PSID=${SID}; HSID=Hval`,
    ]) {
      const jar = toNetscapeCookies(text);
      expectLoadable(jar);
      expect(countCookieLines(jar)).toBe(3);
      expect(hasAuthCookie(jar)).toBe(true);
    }
  });

  it("keeps base64 padding in a value (splits on the FIRST '=' only)", () => {
    const jar = toNetscapeCookies("SAPISID=AbC123==; YSC=x");
    expect(jar).toContain("\tSAPISID\tAbC123==");
  });

  it("still parses a header that picked up a stray tab", () => {
    // A stray tab used to route the text into the Netscape branch, which passed the wreckage
    // straight through as a jar yt-dlp then refused.
    const jar = toNetscapeCookies(`YSC=abc;\t__Secure-1PSID=${SID}`);
    expectLoadable(jar);
    expect(hasAuthCookie(jar)).toBe(true);
  });
});

describe("paste format: a cookie-extension JSON export", () => {
  it("converts an array of cookie objects", () => {
    const jar = toNetscapeCookies(
      JSON.stringify([
        {
          name: "__Secure-1PSID",
          value: SID,
          domain: ".youtube.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expirationDate: 1893456000,
        },
        { name: "YSC", value: "abc", domain: ".youtube.com", path: "/", secure: true },
      ]),
    );
    expectLoadable(jar);
    expect(countCookieLines(jar)).toBe(2);
    expect(hasAuthCookie(jar)).toBe(true);
    expect(jar).toContain("\t1893456000\t__Secure-1PSID\t");
  });

  it("accepts the { cookies: [...] } wrapper too", () => {
    const jar = toNetscapeCookies(
      JSON.stringify({ cookies: [{ name: "SID", value: SID, domain: ".google.com" }] }),
    );
    expectLoadable(jar);
    expect(hasAuthCookie(jar)).toBe(true);
  });

  it("writes a SESSION cookie far-future, not expiry 0 (yt-dlp discards those)", () => {
    // A fresh sign-in produces session cookies; stamping 0 would throw away the very cookies
    // the operator just went to the trouble of exporting.
    const jar = toNetscapeCookies(
      JSON.stringify([{ name: "SID", value: SID, domain: ".youtube.com" }]),
    );
    expect(jar).toContain("\t2000000000\tSID\t");
  });
});

describe("paste format: inputs that must be REFUSED, not half-accepted", () => {
  // The console checks countCookieLines(jar) === 0 and rejects BEFORE writing, so these can
  // never overwrite a working jar.
  it("rejects prose, empty text, and a bare word", () => {
    for (const text of ["", "   ", "here are my cookies", "no"]) {
      expect(countCookieLines(toNetscapeCookies(text))).toBe(0);
    }
  });

  it("rejects the DevTools Application-tab cookie TABLE", () => {
    // Columns are Name/Value/Domain/Path/Expires/Size/HttpOnly/… — a different order and a
    // different width. Guessing at it would silently write a jar of nonsense; refusing sends
    // the operator to the Network tab, which is the shape that actually works.
    const table = [
      "Name\tValue\tDomain\tPath\tExpires / Max-Age\tSize\tHttpOnly\tSecure\tSameSite",
      `SID\t${SID}\t.youtube.com\t/\t2027-01-01T00:00:00.000Z\t82\t✓\t✓\tNone`,
    ].join("\n");
    expect(countCookieLines(toNetscapeCookies(table))).toBe(0);
  });

  it("rejects an 8-field line instead of welding the extra field onto the value", () => {
    // A stray tab. Merging it into the value would produce a jar that PARSES cleanly and
    // authenticates nothing — and on an unflagged IP the probe would pass, so the console
    // would report "saved and working" over a corrupted session. Refusing is the safe answer.
    const mangled = `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\t${SID}\tEXTRA`;
    expect(countCookieLines(toNetscapeCookies(mangled))).toBe(0);
  });

  it("rejects a JSON export with no usable entries instead of inventing lines", () => {
    expect(countCookieLines(toNetscapeCookies("[]"))).toBe(0);
    expect(countCookieLines(toNetscapeCookies('[{"value":"x"}]'))).toBe(0);
  });
});
