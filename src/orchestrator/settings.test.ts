import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  CROSSFADE_MAX_SEC,
  IDLE_TIMEOUT_MAX_SEC,
} from "./settings.js";

describe("applySettingsPatch", () => {
  it("returns base unchanged for an empty patch", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
    expect(applySettingsPatch(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps idleTimeoutSec into [0, max] and rounds", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { idleTimeoutSec: -5 }).idleTimeoutSec).toBe(0);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { idleTimeoutSec: 99999 }).idleTimeoutSec).toBe(
      IDLE_TIMEOUT_MAX_SEC,
    );
    expect(applySettingsPatch(DEFAULT_SETTINGS, { idleTimeoutSec: 12.7 }).idleTimeoutSec).toBe(13);
  });

  it("clamps crossfadeSec into [0, max]", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { crossfadeSec: -1 }).crossfadeSec).toBe(0);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { crossfadeSec: 1000 }).crossfadeSec).toBe(
      CROSSFADE_MAX_SEC,
    );
    expect(applySettingsPatch(DEFAULT_SETTINGS, { crossfadeSec: 4 }).crossfadeSec).toBe(4);
  });

  it("accepts only boolean normalizeLoudness, else keeps base", () => {
    expect(
      applySettingsPatch(DEFAULT_SETTINGS, { normalizeLoudness: true }).normalizeLoudness,
    ).toBe(true);
    const base = { ...DEFAULT_SETTINGS, normalizeLoudness: true };
    expect(applySettingsPatch(base, { normalizeLoudness: "yes" }).normalizeLoudness).toBe(true);
  });

  it("accepts only valid repeat modes, else keeps base", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { repeat: "all" }).repeat).toBe("all");
    expect(applySettingsPatch(DEFAULT_SETTINGS, { repeat: "one" }).repeat).toBe("one");
    expect(applySettingsPatch(DEFAULT_SETTINGS, { repeat: "bogus" }).repeat).toBe("off");
  });

  it("ignores unrelated / non-numeric input gracefully", () => {
    const out = applySettingsPatch(DEFAULT_SETTINGS, {
      idleTimeoutSec: "abc",
      crossfadeSec: NaN,
    });
    expect(out.idleTimeoutSec).toBe(DEFAULT_SETTINGS.idleTimeoutSec);
    expect(out.crossfadeSec).toBe(DEFAULT_SETTINGS.crossfadeSec);
  });
});
