import { describe, it, expect, vi } from "vitest";
import { ActivityType } from "discord.js";
import { buildPresenceActivity, PresenceController } from "./presence.js";

describe("buildPresenceActivity", () => {
  it("builds a 'Listening to <title>' activity for a started track", () => {
    const a = buildPresenceActivity("Bohemian Rhapsody", undefined);
    expect(a).toEqual({ name: "Bohemian Rhapsody", type: ActivityType.Listening });
  });

  it("falls back to the default help/panel activity when nothing is playing", () => {
    const a = buildPresenceActivity(null, "https://panel.example");
    expect(a.type).toBe(ActivityType.Listening);
    expect(a.name).toContain("?help");
    expect(a.name).toContain("https://panel.example");
  });

  it("default activity omits the panel segment when no baseUrl is given", () => {
    const a = buildPresenceActivity(null, undefined);
    expect(a.name).toContain("?help");
    expect(a.name).not.toContain("·");
  });

  it("truncates an over-long title to Discord's 128-char activity limit", () => {
    const long = "x".repeat(200);
    const a = buildPresenceActivity(long, undefined);
    expect(a.name.length).toBeLessThanOrEqual(128);
  });
});

function fakeClient() {
  const setActivity = vi.fn();
  return { setActivity, client: { user: { setActivity } } as never };
}

describe("PresenceController", () => {
  it("sets 'Listening to <title>' on a track start", () => {
    const { client, setActivity } = fakeClient();
    const pc = new PresenceController(client, { baseUrl: "https://p" });
    pc.onTrackStart("g1", "My Song");
    expect(setActivity).toHaveBeenCalledWith("My Song", { type: ActivityType.Listening });
  });

  it("reflects the most-recently-started track across guilds (last writer wins)", () => {
    const { client, setActivity } = fakeClient();
    const pc = new PresenceController(client);
    pc.onTrackStart("g1", "First");
    pc.onTrackStart("g2", "Second");
    expect(setActivity).toHaveBeenLastCalledWith("Second", { type: ActivityType.Listening });
  });

  it("reverts to the default presence when the last-playing guild goes idle", () => {
    const { client, setActivity } = fakeClient();
    const pc = new PresenceController(client, { baseUrl: "https://p" });
    pc.onTrackStart("g1", "Song");
    pc.onIdle("g1");
    const last = setActivity.mock.calls.at(-1)![0] as string;
    expect(last).toContain("?help");
  });

  it("ignores an idle from a guild that is not the current presence holder", () => {
    const { client, setActivity } = fakeClient();
    const pc = new PresenceController(client);
    pc.onTrackStart("g1", "A");
    pc.onTrackStart("g2", "B");
    setActivity.mockClear();
    pc.onIdle("g1"); // g1 is no longer the holder; presence should stay on B
    expect(setActivity).not.toHaveBeenCalled();
  });

  it("never throws when the underlying setActivity blows up (best-effort)", () => {
    const setActivity = vi.fn(() => {
      throw new Error("gateway not ready");
    });
    const client = { user: { setActivity } } as never;
    const pc = new PresenceController(client);
    expect(() => pc.onTrackStart("g1", "Song")).not.toThrow();
  });

  it("does not crash when client.user is null (pre-ready)", () => {
    const pc = new PresenceController({ user: null } as never);
    expect(() => pc.onTrackStart("g1", "Song")).not.toThrow();
  });

  it("can apply the default presence on demand (e.g. at startup)", () => {
    const { client, setActivity } = fakeClient();
    const pc = new PresenceController(client, { baseUrl: "https://p" });
    pc.applyDefault();
    expect(setActivity).toHaveBeenCalledOnce();
    expect(setActivity.mock.calls[0]![0] as string).toContain("?help");
  });
});
