import { describe, it, expect } from "vitest";
import { fmtAudio, fmtTime } from "./format.js";

describe("fmtTime", () => {
  it("formats 125 seconds as 2:05", () => {
    expect(fmtTime(125)).toBe("2:05");
  });
  it("returns —:— for null", () => {
    expect(fmtTime(null)).toBe("—:—");
  });
  it("formats durations over an hour with an hours segment (h:mm:ss)", () => {
    expect(fmtTime(3600)).toBe("1:00:00");
    expect(fmtTime(3661)).toBe("1:01:01");
    expect(fmtTime(5400)).toBe("1:30:00");
    // No spurious hours segment just under an hour.
    expect(fmtTime(3599)).toBe("59:59");
  });
});

describe("fmtAudio", () => {
  it("returns null when audio is null", () => {
    expect(fmtAudio(null)).toBeNull();
  });
  it("formats codec, bitrate, and sample rate", () => {
    expect(fmtAudio({ codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 })).toBe(
      "opus · 160 kbps · 48 kHz",
    );
  });
  it("shows a fractional kHz when not a whole number of kHz", () => {
    expect(fmtAudio({ codec: "aac", bitrateKbps: 128, sampleRateHz: 44100 })).toBe(
      "aac · 128 kbps · 44.1 kHz",
    );
  });
  it("drops zeroed numeric fields but keeps the codec", () => {
    expect(fmtAudio({ codec: "opus", bitrateKbps: 0, sampleRateHz: 0 })).toBe("opus");
  });
  it("returns null when there is nothing useful to show", () => {
    expect(fmtAudio({ codec: "", bitrateKbps: 0, sampleRateHz: 0 })).toBeNull();
  });
});
