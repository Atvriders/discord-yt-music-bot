import { describe, it, expect } from "vitest";
import { parseCommand } from "./command-parser.js";

describe("parseCommand", () => {
  it("returns none without the prefix", () => {
    expect(parseCommand("hello")).toEqual({ kind: "none" });
  });
  it("parses control keywords", () => {
    expect(parseCommand("?skip")).toEqual({ kind: "skip" });
    expect(parseCommand("?pause")).toEqual({ kind: "pause" });
    expect(parseCommand("?resume")).toEqual({ kind: "resume" });
    expect(parseCommand("?stop")).toEqual({ kind: "stop" });
    expect(parseCommand("?queue")).toEqual({ kind: "queue" });
    expect(parseCommand("?np")).toEqual({ kind: "np" });
    expect(parseCommand("?history")).toEqual({ kind: "history" });
    expect(parseCommand("?help")).toEqual({ kind: "help" });
  });
  it("parses `play <input>` and bare `?<url|query>`", () => {
    expect(parseCommand("?play https://youtu.be/x")).toEqual({
      kind: "play",
      input: "https://youtu.be/x",
    });
    expect(parseCommand("?https://youtu.be/x")).toEqual({
      kind: "play",
      input: "https://youtu.be/x",
    });
    expect(parseCommand("?daft punk one more time")).toEqual({
      kind: "play",
      input: "daft punk one more time",
    });
  });
  it("parses remove with a 1-based index", () => {
    expect(parseCommand("?remove 3")).toEqual({ kind: "remove", index: 3 });
    expect(parseCommand("?remove 1")).toEqual({ kind: "remove", index: 1 }); // minimum valid 1-based index
    expect(parseCommand("?remove 0")).toEqual({ kind: "help" }); // lower-bound rejection (n >= 1)
    expect(parseCommand("?remove -1")).toEqual({ kind: "help" }); // negative rejected too
    expect(parseCommand("?remove")).toEqual({ kind: "help" });
    expect(parseCommand("?remove abc")).toEqual({ kind: "help" });
  });
  it("parses volume 0-200 (and the vol alias / trailing %)", () => {
    expect(parseCommand("?volume 50")).toEqual({ kind: "volume", percent: 50 });
    expect(parseCommand("?volume 0")).toEqual({ kind: "volume", percent: 0 });
    expect(parseCommand("?volume 200")).toEqual({ kind: "volume", percent: 200 });
    expect(parseCommand("?vol 120")).toEqual({ kind: "volume", percent: 120 });
    expect(parseCommand("?volume 80%")).toEqual({ kind: "volume", percent: 80 });
    expect(parseCommand("?volume 73.6")).toEqual({ kind: "volume", percent: 74 });
  });
  it("rejects out-of-range / missing / non-numeric volume → help", () => {
    expect(parseCommand("?volume")).toEqual({ kind: "help" });
    expect(parseCommand("?volume 201")).toEqual({ kind: "help" });
    expect(parseCommand("?volume -5")).toEqual({ kind: "help" });
    expect(parseCommand("?volume loud")).toEqual({ kind: "help" });
  });
  it("bare prefix or empty play falls back to help", () => {
    expect(parseCommand("?")).toEqual({ kind: "help" });
    expect(parseCommand("?play")).toEqual({ kind: "help" });
  });
  it("parses `?channel` (no arg) as set-restriction-to-this-channel", () => {
    expect(parseCommand("?channel")).toEqual({ kind: "channel", mode: "set" });
  });
  it("parses `?channel off|none|clear` (any case) as remove-restriction", () => {
    expect(parseCommand("?channel off")).toEqual({ kind: "channel", mode: "off" });
    expect(parseCommand("?channel none")).toEqual({ kind: "channel", mode: "off" });
    expect(parseCommand("?channel clear")).toEqual({ kind: "channel", mode: "off" });
    expect(parseCommand("?channel OFF")).toEqual({ kind: "channel", mode: "off" });
  });
  it("treats `?channel <other arg>` as set (ignores stray args)", () => {
    expect(parseCommand("?channel here")).toEqual({ kind: "channel", mode: "set" });
  });

  it("respects a custom prefix", () => {
    expect(parseCommand("!skip", "!")).toEqual({ kind: "skip" });
    expect(parseCommand("?skip", "!")).toEqual({ kind: "none" });
  });
});
