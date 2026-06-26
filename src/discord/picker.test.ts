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
    expect(json.components[0]!.custom_id).toBe("pick:aaaaaaaaaaa");
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
});
