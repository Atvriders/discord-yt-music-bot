import { describe, it, expect } from "vitest";
import { buildPicker, decodePick } from "./picker.js";
import type { TrackMeta } from "../types/index.js";

const r = (id: string, title: string): TrackMeta => ({
  videoId: id,
  title,
  channel: "c",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
});

describe("picker", () => {
  it("builds one button per result (max 5) with pick:<videoId> ids", () => {
    const results = [r("aaaaaaaaaaa", "A"), r("bbbbbbbbbbb", "B")];
    const { content, components } = buildPicker(results);
    expect(content).toContain("A");
    expect(content).toContain("B");
    const row = components[0]!;
    const json = row.toJSON();
    expect(json.components).toHaveLength(2);
    const first = json.components[0]!;
    expect("custom_id" in first ? first.custom_id : undefined).toBe("pick:aaaaaaaaaaa");
  });

  it("caps at 5 buttons", () => {
    const results = Array.from({ length: 8 }, (_, i) => r(`id${i}`.padEnd(11, "0"), `T${i}`));
    const { components } = buildPicker(results);
    const total = components.reduce((n, row) => n + row.toJSON().components.length, 0);
    expect(total).toBe(5);
  });

  it("decodePick extracts the videoId, or null for foreign ids", () => {
    expect(decodePick("pick:aaaaaaaaaaa")).toBe("aaaaaaaaaaa");
    expect(decodePick("other:x")).toBeNull();
  });

  it("formats a fractional (float) duration as a clean m:ss, not a fractional string", () => {
    // yt-dlp emits duration as a float (e.g. 183.145). The picker must render "3:03",
    // never "3:3.145".
    const { content } = buildPicker([{ ...r("aaaaaaaaaaa", "A"), durationSec: 183.145 }]);
    expect(content).toContain("(3:03)");
    expect(content).not.toMatch(/\d\.\d/);
  });
});
