import { describe, it, expect } from "vitest";
import { buildAudioFilter } from "./filter.js";

const off = { crossfadeSec: 0, normalizeLoudness: false, fx: "none" as const };

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

  it("clamps the fade-in to the track length and omits fade-out for a sub-crossfade track", () => {
    // A 5s fade-in on a 4s track would get cut off mid-ramp; clamp it to d=4.
    const f = buildAudioFilter({ crossfadeSec: 5, normalizeLoudness: false }, 4, false);
    expect(f).toBe("afade=t=in:st=0:d=4");
  });

  it("keeps a full fade-in but omits fade-out when duration equals the crossfade", () => {
    // duration === crossfade: fade-in spans the whole track (d=5); fade-out is omitted
    // because the guard requires duration STRICTLY greater than the crossfade.
    const f = buildAudioFilter({ crossfadeSec: 5, normalizeLoudness: false }, 5, false);
    expect(f).toBe("afade=t=in:st=0:d=5");
  });

  it("computes the fade-out start from the remaining duration after a seek", () => {
    // 180s track, seek 170s → only 10s of output remains. Fade-out must start at
    // (10-3)=7 (relative to the seeked output), not 177 which would never fire.
    const f = buildAudioFilter({ crossfadeSec: 3, normalizeLoudness: false }, 180, false, 170_000);
    expect(f).toContain("afade=t=in:st=0:d=3");
    expect(f).toContain("afade=t=out:st=7:d=3");
  });

  it("omits fade-out when a seek leaves less than the crossfade remaining", () => {
    // 180s track, seek 178s → 2s left, shorter than the 3s crossfade: fade-in clamps to
    // the 2s remainder and the fade-out is dropped.
    const f = buildAudioFilter({ crossfadeSec: 3, normalizeLoudness: false }, 180, false, 178_000);
    expect(f).toBe("afade=t=in:st=0:d=2");
  });

  it("combines loudnorm and crossfade in one chain", () => {
    const f = buildAudioFilter({ crossfadeSec: 2, normalizeLoudness: true }, 30, false);
    expect(f).toBe("loudnorm,afade=t=in:st=0:d=2,afade=t=out:st=28:d=2");
  });

  it("returns null for the 'none' fx preset with no other processing", () => {
    expect(buildAudioFilter(off, 180, false)).toBeNull();
  });

  it("emits the correct ffmpeg fragment for each FX preset", () => {
    const cases: Record<string, string> = {
      bassboost: "bass=g=15",
      // nightcore/vaporwave include an explicit aformat=channel_layouts=stereo before the
      // resample so the fragment is self-contained (see the loudnorm-chain test below).
      nightcore: "aformat=channel_layouts=stereo,aresample=48000,asetrate=48000*1.25",
      vaporwave: "asetrate=48000*0.8,aformat=channel_layouts=stereo,aresample=48000",
      eightd: "apulsator=hz=0.09",
      treble: "treble=g=10",
      karaoke: "stereotools=mlev=0.015",
    };
    for (const [fx, frag] of Object.entries(cases)) {
      expect(buildAudioFilter({ ...off, fx: fx as never }, 180, false)).toBe(frag);
    }
  });

  it("guards nightcore/vaporwave with an aformat BEFORE the aresample when loudnorm precedes them", () => {
    // Regression: loudnorm emits a non-standard channel-layout annotation; a downstream
    // aresample then fails hard ("Unknown channel layouts not supported ... Failed to inject
    // frame"), closing ffmpeg's stdout → an empty stream → a silently-failed track. The
    // explicit aformat pins a concrete layout so the aresample can always negotiate, making
    // the loudnorm + nightcore/vaporwave combination valid.
    for (const fx of ["nightcore", "vaporwave"] as const) {
      const f = buildAudioFilter({ ...off, normalizeLoudness: true, fx }, 180, false)!;
      expect(f.startsWith("loudnorm,")).toBe(true);
      const afmt = f.indexOf("aformat=channel_layouts=stereo");
      const resample = f.indexOf("aresample=48000");
      expect(afmt).toBeGreaterThanOrEqual(0);
      // The layout guard must precede the resample so the resample has a concrete layout.
      expect(afmt).toBeLessThan(resample);
    }
  });

  it("appends the FX preset after loudnorm + crossfade", () => {
    const f = buildAudioFilter(
      { crossfadeSec: 2, normalizeLoudness: true, fx: "bassboost" },
      30,
      false,
    );
    expect(f).toBe("loudnorm,afade=t=in:st=0:d=2,afade=t=out:st=28:d=2,bass=g=15");
  });
});
