import { describe, it, expect } from "vitest";
import { buildAudioFilter } from "./filter.js";

const off = { crossfadeSec: 0, normalizeLoudness: false };

describe("buildAudioFilter", () => {
  it("returns null when no processing is requested", () => {
    expect(buildAudioFilter(off, 180, false)).toBeNull();
  });

  it("emits loudnorm when normalize is on", () => {
    expect(buildAudioFilter({ ...off, normalizeLoudness: true }, 180, false)).toBe("loudnorm");
  });

  it("emits fade-in and fade-out for a known-duration track", () => {
    const f = buildAudioFilter({ crossfadeSec: 3, normalizeLoudness: false }, 60, false);
    expect(f).toContain("afade=t=in:st=0:d=3");
    expect(f).toContain("afade=t=out:st=57:d=3");
  });

  it("omits the fade-out for live / unknown-duration tracks (no end time)", () => {
    const live = buildAudioFilter({ crossfadeSec: 3, normalizeLoudness: false }, null, true);
    expect(live).toBe("afade=t=in:st=0:d=3");
    const unknown = buildAudioFilter({ crossfadeSec: 3, normalizeLoudness: false }, null, false);
    expect(unknown).toBe("afade=t=in:st=0:d=3");
  });

  it("omits fade-out when the track is shorter than the crossfade", () => {
    const f = buildAudioFilter({ crossfadeSec: 5, normalizeLoudness: false }, 4, false);
    expect(f).toBe("afade=t=in:st=0:d=5");
  });

  it("combines loudnorm and crossfade in one chain", () => {
    const f = buildAudioFilter({ crossfadeSec: 2, normalizeLoudness: true }, 30, false);
    expect(f).toBe("loudnorm,afade=t=in:st=0:d=2,afade=t=out:st=28:d=2");
  });
});
