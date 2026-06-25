import { describe, it, expect } from "vitest";
import { parseInput } from "./url-parser.js";

const ID = "dQw4w9WgXcQ";

describe("parseInput — video URLs", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/watch?v=${ID}&list=PLxxxxxxxx`, // playlist param ignored
  ])("extracts the video id from %s", (url) => {
    expect(parseInput(url)).toEqual({ kind: "video", videoId: ID });
  });
});

describe("parseInput — rejections", () => {
  it("rejects a bare playlist URL with no video", () => {
    const r = parseInput("https://www.youtube.com/playlist?list=PLxxxx");
    expect(r.kind).toBe("reject");
  });
  it("rejects a non-YouTube URL", () => {
    const r = parseInput("https://vimeo.com/12345");
    expect(r).toEqual({ kind: "reject", reason: expect.stringContaining("YouTube") });
  });
  it("rejects an empty string", () => {
    expect(parseInput("   ").kind).toBe("reject");
  });
});

describe("parseInput — queries", () => {
  it("treats plain text as a search query", () => {
    expect(parseInput("daft punk one more time")).toEqual({
      kind: "query",
      query: "daft punk one more time",
    });
  });
  it("trims surrounding whitespace on a query", () => {
    expect(parseInput("  lofi beats  ")).toEqual({ kind: "query", query: "lofi beats" });
  });
});
