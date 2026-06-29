import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  CROSSFADE_MAX_SEC,
  IDLE_TIMEOUT_MAX_SEC,
  MAX_TRACK_DURATION_CEILING_SEC,
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
    // Start from a NON-default base so this exercises "keep base" rather than passing
    // vacuously because the hard-coded fallback happens to equal the default ("off").
    const base = { ...DEFAULT_SETTINGS, repeat: "all" as const };
    expect(applySettingsPatch(base, { repeat: "bogus" }).repeat).toBe("all");
    expect(applySettingsPatch(base, { repeat: 42 }).repeat).toBe("all");
  });

  it("accepts only boolean autoplay, else keeps base", () => {
    expect(DEFAULT_SETTINGS.autoplay).toBe(false);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { autoplay: true }).autoplay).toBe(true);
    const base = { ...DEFAULT_SETTINGS, autoplay: true };
    expect(applySettingsPatch(base, { autoplay: "yes" }).autoplay).toBe(true);
    expect(applySettingsPatch(base, { autoplay: false }).autoplay).toBe(false);
  });

  it("defaults autoplaySource to 'radio' and accepts only the two literals, else keeps base", () => {
    expect(DEFAULT_SETTINGS.autoplaySource).toBe("radio");
    expect(applySettingsPatch(DEFAULT_SETTINGS, { autoplaySource: "artist" }).autoplaySource).toBe(
      "artist",
    );
    expect(applySettingsPatch(DEFAULT_SETTINGS, { autoplaySource: "radio" }).autoplaySource).toBe(
      "radio",
    );
    // A base set to "artist" survives an invalid patch value (kept, not reset).
    const base = { ...DEFAULT_SETTINGS, autoplaySource: "artist" as const };
    expect(applySettingsPatch(base, { autoplaySource: "bogus" }).autoplaySource).toBe("artist");
    expect(applySettingsPatch(base, { autoplaySource: 42 }).autoplaySource).toBe("artist");
  });

  it("defaults maxTrackDurationSec to 0 (no limit)", () => {
    expect(DEFAULT_SETTINGS.maxTrackDurationSec).toBe(0);
  });

  it("carries maxTrackDurationSec through a patch, coercing to a non-negative integer", () => {
    expect(
      applySettingsPatch(DEFAULT_SETTINGS, { maxTrackDurationSec: 10800 }).maxTrackDurationSec,
    ).toBe(10800);
    // 0 = no limit, explicitly allowed.
    const base = { ...DEFAULT_SETTINGS, maxTrackDurationSec: 3600 };
    expect(applySettingsPatch(base, { maxTrackDurationSec: 0 }).maxTrackDurationSec).toBe(0);
    // rounds fractional input.
    expect(
      applySettingsPatch(DEFAULT_SETTINGS, { maxTrackDurationSec: 12.7 }).maxTrackDurationSec,
    ).toBe(13);
  });

  it("clamps maxTrackDurationSec into [0, ceiling]", () => {
    expect(
      applySettingsPatch(DEFAULT_SETTINGS, { maxTrackDurationSec: -5 }).maxTrackDurationSec,
    ).toBe(0);
    expect(
      applySettingsPatch(DEFAULT_SETTINGS, { maxTrackDurationSec: 999999 }).maxTrackDurationSec,
    ).toBe(MAX_TRACK_DURATION_CEILING_SEC);
  });

  it("keeps base maxTrackDurationSec for a non-numeric / undefined patch value", () => {
    const base = { ...DEFAULT_SETTINGS, maxTrackDurationSec: 7200 };
    expect(applySettingsPatch(base, { maxTrackDurationSec: "abc" }).maxTrackDurationSec).toBe(7200);
    expect(applySettingsPatch(base, { maxTrackDurationSec: NaN }).maxTrackDurationSec).toBe(7200);
    expect(applySettingsPatch(base, {}).maxTrackDurationSec).toBe(7200);
  });

  it("ignores unrelated / non-numeric input gracefully", () => {
    const out = applySettingsPatch(DEFAULT_SETTINGS, {
      idleTimeoutSec: "abc",
      crossfadeSec: NaN,
    });
    expect(out.idleTimeoutSec).toBe(DEFAULT_SETTINGS.idleTimeoutSec);
    expect(out.crossfadeSec).toBe(DEFAULT_SETTINGS.crossfadeSec);
  });

  it("treats an explicit null numeric field as absent (keeps base, never coerces to 0)", () => {
    // JSON `null` is not `undefined`; without the `== null` guard clampInt(null,…) would
    // coerce to 0 and silently zero the field (idleTimeoutSec 0 = stay forever).
    const base = {
      ...DEFAULT_SETTINGS,
      idleTimeoutSec: 300,
      crossfadeSec: 4,
      maxTrackDurationSec: 7200,
    };
    expect(applySettingsPatch(base, { idleTimeoutSec: null }).idleTimeoutSec).toBe(300);
    expect(applySettingsPatch(base, { crossfadeSec: null }).crossfadeSec).toBe(4);
    expect(applySettingsPatch(base, { maxTrackDurationSec: null }).maxTrackDurationSec).toBe(7200);
  });
});
