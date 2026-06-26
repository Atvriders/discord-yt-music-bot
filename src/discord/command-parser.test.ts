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
    expect(parseCommand("?remove")).toEqual({ kind: "help" });
    expect(parseCommand("?remove abc")).toEqual({ kind: "help" });
  });
  it("bare prefix or empty play falls back to help", () => {
    expect(parseCommand("?")).toEqual({ kind: "help" });
    expect(parseCommand("?play")).toEqual({ kind: "help" });
  });
  it("respects a custom prefix", () => {
    expect(parseCommand("!skip", "!")).toEqual({ kind: "skip" });
    expect(parseCommand("?skip", "!")).toEqual({ kind: "none" });
  });
});
