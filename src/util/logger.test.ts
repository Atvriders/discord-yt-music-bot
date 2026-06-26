import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("creates a logger at the requested level", () => {
    const log = createLogger("warn");
    expect(log.level).toBe("warn");
    expect(typeof log.info).toBe("function");
  });
  it("defaults to info for an unknown level", () => {
    expect(createLogger("nonsense").level).toBe("info");
  });
});
