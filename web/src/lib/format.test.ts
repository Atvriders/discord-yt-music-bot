import { describe, it, expect } from "vitest";
import { fmtTime } from "./format.js";

describe("fmtTime", () => {
  it("formats 125 seconds as 2:05", () => {
    expect(fmtTime(125)).toBe("2:05");
  });
  it("returns —:— for null", () => {
    expect(fmtTime(null)).toBe("—:—");
  });
});
