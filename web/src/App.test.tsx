// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { App } from "./components/App.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("App", () => {
  it("shows the login gate when /api/me is unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "unauthenticated" }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Continue with Discord/i)).toBeTruthy());
  });
  it("now-playing reflects the NEW track when a second state arrives (skip/advance) — not the stale previous one", async () => {
    // Regression: on a skip/advance the panel must replace the now-playing card with
    // the new track. A reducer that shallow-merged `current` (or a NowPlaying that
    // memoized the previous track) would leave the old title/thumbnail showing.
    let wsRef: { deliver: (state: unknown) => void } | null = null;
    class FakeWS {
      readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor() {
        wsRef = { deliver: (state) => this.emit("message", { data: JSON.stringify({ type: "state", state }) }) };
        setTimeout(() => this.emit("open", {}), 0);
      }
      addEventListener(ev: string, cb: (e: unknown) => void) { (this.listeners[ev] ??= []).push(cb); }
      emit(ev: string, e: unknown) { for (const cb of this.listeners[ev] ?? []) cb(e); }
      send() {} close() {}
    }
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [], currentChannelId: null }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    const track = (videoId: string, title: string) => ({
      id: "q-" + videoId, addedAt: 0, positionMs: 0, durationMs: 100000,
      meta: { videoId, title, channel: "ch", durationSec: 100, isLive: false, thumbnailUrl: "http://x/" + videoId + ".jpg" },
      requester: { discordUserId: "1", displayName: "dj", avatarUrl: "", source: "web" },
    });

    render(<App />);
    await waitFor(() => expect(wsRef).not.toBeNull());
    wsRef!.deliver({ current: track("aaa", "First Track"), upcoming: [], history: [], paused: false, idleTimeoutSec: 300 });
    await screen.findByText("First Track");

    // Skip/advance: a fresh state with a new current.
    wsRef!.deliver({ current: track("bbb", "Second Track"), upcoming: [], history: [], paused: false, idleTimeoutSec: 300 });
    await waitFor(() => expect(document.querySelector("h1")?.textContent).toBe("Second Track"));
    expect(screen.queryByText("First Track")).toBeNull();
    const thumb = document.querySelector("img[width='132']") as HTMLImageElement;
    expect(thumb.src).toContain("bbb.jpg"); // thumbnail updated too, not the previous track's
  });

  it("surfaces an error when a control action (pause) fails instead of swallowing it", async () => {
    // A minimal WebSocket that immediately delivers a snapshot with a current track,
    // so the Controls are enabled and the Pause button is clickable.
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor() {
        setTimeout(() => {
          this.emit("open", {});
          this.emit("message", {
            data: JSON.stringify({
              type: "state",
              state: {
                current: { id: "q1", meta: { title: "Now Spinning", channel: "ch", durationSec: 100 }, requester: {} },
                upcoming: [],
                history: [],
              },
            }),
          });
        }, 0);
      }
      addEventListener(ev: string, cb: (e: unknown) => void) {
        (this.listeners[ev] ??= []).push(cb);
      }
      emit(ev: string, e: unknown) {
        for (const cb of this.listeners[ev] ?? []) cb(e);
      }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);

    let pauseCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [] }) });
      }
      if (url.endsWith("/api/guilds/G1/pause")) {
        pauseCalls++;
        return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: "forbidden" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ current: null, upcoming: [], history: [] }) });
    }));

    render(<App />);
    // Wait until the live track is rendered — only then is the Pause button enabled.
    await screen.findByText("Now Spinning");
    const pauseBtn = await screen.findByRole("button", { name: "Pause" });
    await waitFor(() => expect((pauseBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(pauseBtn);

    // The control call was made...
    await waitFor(() => expect(pauseCalls).toBe(1));
    // ...and the failure is surfaced to the user, not silently swallowed.
    await waitFor(() => expect(screen.getByText(/forbidden|couldn't pause|pause failed/i)).toBeTruthy());
  });

  it("ITEM 1: defaults to the stored guild when it is one the user can control", async () => {
    localStorage.setItem("ytbot.guildId", "G2");
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "First Room" }, { id: "G2", name: "Second Room" }] }) });
      }
      if (url.includes("/api/guilds/G2/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [], currentChannelId: null }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [], currentChannelId: null, current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    // The stored guild G2 should be the active selection (its voice-channels are fetched).
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/guilds/G2/voice-channels"))).toBe(true),
    );
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/guilds/G1/voice-channels"))).toBe(false);
  });

  it("ITEM 1: ignores a stored guild the user can no longer control and falls back to the first", async () => {
    localStorage.setItem("ytbot.guildId", "GHOST");
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "First Room" }] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [], currentChannelId: null }) });
    }));
    render(<App />);
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/guilds/G1/voice-channels"))).toBe(true),
    );
  });

  it("ITEM 2: auto-selects the voice channel the user is currently in", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [{ id: "C1", name: "General" }, { id: "C2", name: "Lounge" }], currentChannelId: "C2" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    const select = (await screen.findByLabelText(/voice channel/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("C2"));
  });

  it("ITEM 5: clears the input and shows a pending indicator immediately on submit", async () => {
    // Defer the /play response so we can observe the UI state BEFORE it resolves.
    let resolvePlay: (v: unknown) => void = () => {};
    const playPromise = new Promise((res) => { resolvePlay = res; });
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [], currentChannelId: null }) });
      }
      if (url.endsWith("/api/guilds/G1/play")) {
        return playPromise.then(() => ({ ok: true, status: 200, json: async () => ({ queued: { id: "q1", title: "My Song" } }) }));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));

    render(<App />);
    const box = (await screen.findByLabelText(/add a track/i)) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "https://youtu.be/abcdefghijk" } });
    expect(box.value).toBe("https://youtu.be/abcdefghijk");
    fireEvent.submit(box.closest("form")!);

    // INSTANT response: the box is cleared and a pending/resolving indicator shows,
    // all BEFORE the /play promise resolves.
    await waitFor(() => expect(box.value).toBe(""));
    // A pending indicator is shown (the "Resolving…" banner and/or button label).
    expect(screen.getAllByText(/resolving/i).length).toBeGreaterThan(0);
    // The submit button is disabled while resolving.
    expect((screen.getByRole("button", { name: /resolving/i }) as HTMLButtonElement).disabled).toBe(true);

    // Now let the resolve finish — the queued banner replaces the pending one.
    resolvePlay(null);
    await waitFor(() => expect(screen.getByText(/Queued: My Song/i)).toBeTruthy());
  });

  it("Settings: shows the current idle timeout from the WS snapshot and posts the new value on change", async () => {
    class FakeWS {
      readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor() {
        setTimeout(() => {
          this.emit("open", {});
          this.emit("message", {
            data: JSON.stringify({
              type: "state",
              state: { current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 600 },
            }),
          });
        }, 0);
      }
      addEventListener(ev: string, cb: (e: unknown) => void) { (this.listeners[ev] ??= []).push(cb); }
      emit(ev: string, e: unknown) { for (const cb of this.listeners[ev] ?? []) cb(e); }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);

    const settingsPosts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [], currentChannelId: null }) });
      }
      if (url.endsWith("/api/guilds/G1/settings") && init?.method === "POST") {
        settingsPosts.push(JSON.parse(String(init.body)));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, idleTimeoutSec: 60 }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }) });
    }));

    render(<App />);
    const sel = (await screen.findByLabelText(/leave channel after tracks end/i)) as HTMLSelectElement;
    // Reflects the WS snapshot (600s = 10 minutes).
    await waitFor(() => expect(sel.value).toBe("600"));
    // Changing it posts the new value to the settings endpoint.
    fireEvent.change(sel, { target: { value: "60" } });
    await waitFor(() => expect(settingsPosts).toContainEqual({ idleTimeoutSec: 60 }));
  });

  it("shows the panel + server selector when logged in", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [{ id: "C1", name: "General" }] }) });
      }
      if (url.includes("/api/guilds/G1/state")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ current: null, upcoming: [], history: [] }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "not found" }) });
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("The Booth")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("General")).toBeTruthy());
  });
});
