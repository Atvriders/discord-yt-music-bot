// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { App } from "./components/App.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("App", () => {
  it("shows the login gate when /api/me is unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: "unauthenticated" }) }));
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
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
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
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [] }) });
      }
      if (url.endsWith("/api/guilds/G1/pause")) {
        pauseCalls++;
        return Promise.resolve({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({ error: "forbidden" }) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [] }) });
    }));

    render(<App />);
    // Wait until the live track is rendered — only then is the Pause button enabled.
    await screen.findByText("Now Spinning");
    const pauseBtn = await screen.findByRole("button", { name: "Pause" });
    await waitFor(() => expect((pauseBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(pauseBtn);

    // The control call was made...
    await waitFor(() => expect(pauseCalls).toBe(1));
    // ...and the failure is surfaced to the user with the action name pinned (not a
    // generic "forbidden" banner that the word 'forbidden' alone would satisfy).
    await waitFor(() => expect(screen.getByText(/couldn't pause — forbidden/i)).toBeTruthy());
    // The optimistic toggle is reverted: the transport button re-labels back to "Pause"
    // after the failed attempt (it must not get stuck on "Resume").
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy());
  });

  it("ITEM 1: defaults to the stored guild when it is one the user can control", async () => {
    localStorage.setItem("ytbot.guildId", "G2");
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "First Room" }, { id: "G2", name: "Second Room" }] }) });
      }
      if (url.includes("/api/guilds/G2/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null, current: null, upcoming: [], history: [], paused: false }) });
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
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "First Room" }] }) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
    }));
    render(<App />);
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => String(c[0]).includes("/api/guilds/G1/voice-channels"))).toBe(true),
    );
  });

  it("ITEM 2: auto-selects the voice channel the user is currently in", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C1", name: "General" }, { id: "C2", name: "Lounge" }], currentChannelId: "C2" }) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
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
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        // A channel the user is in is auto-selected, so the add isn't short-circuited.
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C1", name: "General" }], currentChannelId: "C1" }) });
      }
      if (url.endsWith("/api/guilds/G1/play")) {
        return playPromise.then(() => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ queued: { id: "q1", title: "My Song" } }) }));
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));

    render(<App />);
    const box = (await screen.findByLabelText(/add a track/i)) as HTMLInputElement;
    // Wait for the user's current voice channel to be auto-selected so the add has a target.
    const vc = (await screen.findByLabelText(/voice channel/i)) as HTMLSelectElement;
    await waitFor(() => expect(vc.value).toBe("C1"));
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
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
      }
      if (url.endsWith("/api/guilds/G1/settings") && init?.method === "POST") {
        settingsPosts.push(JSON.parse(String(init.body)));
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, idleTimeoutSec: 60 }) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }) });
    }));

    render(<App />);
    const sel = (await screen.findByLabelText(/leave channel after tracks end/i)) as HTMLSelectElement;
    // Reflects the WS snapshot (600s = 10 minutes).
    await waitFor(() => expect(sel.value).toBe("600"));
    // Changing it posts the new value to the settings endpoint.
    fireEvent.change(sel, { target: { value: "60" } });
    await waitFor(() => expect(settingsPosts).toContainEqual({ idleTimeoutSec: 60 }));
  });

  it("Command channel: reflects the WS snapshot value and posts a commandChannelId patch on change", async () => {
    class FakeWS {
      readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor() {
        setTimeout(() => {
          this.emit("open", {});
          this.emit("message", {
            data: JSON.stringify({
              type: "state",
              state: { current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300, commandChannelId: "T1" },
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
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
      }
      if (url.includes("/api/guilds/G1/text-channels")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "T1", name: "general" }, { id: "T2", name: "music" }] }) });
      }
      if (url.endsWith("/api/guilds/G1/settings") && init?.method === "POST") {
        settingsPosts.push(JSON.parse(String(init.body)));
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ settings: { commandChannelId: "T2" } }) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }) });
    }));

    render(<App />);
    const sel = (await screen.findByLabelText(/command channel/i)) as HTMLSelectElement;
    // Reflects the WS snapshot's commandChannelId.
    await waitFor(() => expect(sel.value).toBe("T1"));
    // Changing it posts the new channel id to the settings endpoint.
    fireEvent.change(sel, { target: { value: "T2" } });
    await waitFor(() => expect(settingsPosts).toContainEqual({ commandChannelId: "T2" }));
    // Selecting "Any channel" posts null.
    fireEvent.change(sel, { target: { value: "" } });
    await waitFor(() => expect(settingsPosts).toContainEqual({ commandChannelId: null }));
  });

  it("shows the panel + server selector when logged in", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) });
      }
      if (url.includes("/api/guilds/G1/voice-channels")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C1", name: "General" }] }) });
      }
      if (url.includes("/api/guilds/G1/state")) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [] }) });
      }
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: "not found" }) });
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("The Booth")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("General")).toBeTruthy());
  });

  // A FakeWS that delivers the given snapshot once it opens, and exposes a deliver()
  // hook to push further snapshots. `liveSnapshot` drives the queue/current display.
  function makeFakeWS(initial: unknown, ref: { current: { deliver: (s: unknown) => void } | null }) {
    return class FakeWS {
      readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor() {
        ref.current = { deliver: (s) => this.emit("message", { data: JSON.stringify({ type: "state", state: s }) }) };
        setTimeout(() => {
          this.emit("open", {});
          if (initial !== undefined) this.emit("message", { data: JSON.stringify({ type: "state", state: initial }) });
        }, 0);
      }
      addEventListener(ev: string, cb: (e: unknown) => void) { (this.listeners[ev] ??= []).push(cb); }
      emit(ev: string, e: unknown) { for (const cb of this.listeners[ev] ?? []) cb(e); }
      send() {}
      close() {}
    };
  }

  const qItem = (id: string, title: string) => ({
    id, addedAt: 0,
    meta: { videoId: id, title, channel: "ch", durationSec: 100, isLive: false, thumbnailUrl: null },
    requester: { discordUserId: "1", displayName: "dj", avatarUrl: "", source: "web" },
  });

  it("BUG 1: surfaces the failure (not a swallowed error) when removing a queue item fails", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({
      current: { ...qItem("aaa", "Now"), positionMs: 0, durationMs: 100000 },
      upcoming: [qItem("bbb", "Queued Song")], history: [], paused: false, idleTimeoutSec: 300,
    }, wsRef) as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
      if (url.endsWith("/queue/remove")) return Promise.resolve({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({ error: "forbidden" }) });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    const removeBtn = await screen.findByRole("button", { name: /Remove Queued Song/i });
    fireEvent.click(removeBtn);
    await waitFor(() => expect(screen.getByText(/Couldn't remove — forbidden/i)).toBeTruthy());
  });

  it("shows the live downloading status from snapshot.preparing and hides it when cleared", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({
      current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300,
      preparing: { videoId: "aaaaaaaaaaa", title: "Long Concert Set", phase: "downloading", percent: 45 },
    }, wsRef) as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    // The live status renders with the title + percent + a progress fill.
    expect(await screen.findByText(/Long Concert Set/)).toBeTruthy();
    expect(screen.getByText(/Downloading/i)).toBeTruthy();
    expect(screen.getByText(/45%/)).toBeTruthy();
    expect((screen.getByTestId("preparing-fill") as HTMLElement).style.width).toBe("45%");

    // Clearing preparing (track started) hides the status entirely.
    act(() => wsRef.current!.deliver({ current: { ...qItem("aaaaaaaaaaa", "Long Concert Set"), positionMs: 0, durationMs: 100000 }, upcoming: [], history: [], paused: false, idleTimeoutSec: 300, preparing: null }));
    await waitFor(() => expect(screen.queryByText(/Downloading/i)).toBeNull());
  });

  it("BUG 1: refetches the snapshot after a successful remove when the WS is not live", async () => {
    // The WS opens, delivers a snapshot (so the queue renders), then CLOSES. While
    // closed the snapshot persists but status is no longer "live", so a successful
    // remove must refetch /state to reflect the change.
    let closeWs: (() => void) | null = null;
    class FakeWS {
      readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
      constructor() {
        closeWs = () => this.emit("close", {});
        setTimeout(() => {
          this.emit("open", {});
          this.emit("message", { data: JSON.stringify({ type: "state", state: { current: null, upcoming: [qItem("bbb", "Queued Song")], history: [], paused: false, idleTimeoutSec: 300 } }) });
        }, 0);
      }
      addEventListener(ev: string, cb: (e: unknown) => void) { (this.listeners[ev] ??= []).push(cb); }
      emit(ev: string, e: unknown) { for (const cb of this.listeners[ev] ?? []) cb(e); }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);

    let stateCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [], currentChannelId: null }) });
      if (url.endsWith("/queue/remove")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) });
      if (url.endsWith("/api/guilds/G1/state")) {
        stateCalls++;
        // Post-removal snapshot: empty queue.
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    await screen.findByRole("button", { name: /Remove Queued Song/i });
    // Wait for the live indicator first, then drop the WS so status is no longer live.
    await waitFor(() => expect(screen.getByText(/● live/)).toBeTruthy());
    closeWs!();
    await waitFor(() => expect(screen.queryByText(/● live/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Remove Queued Song/i }));
    // The remove triggers a /state refetch (since status !== "live") which empties the queue.
    await waitFor(() => expect(screen.queryByText("Queued Song")).toBeNull());
    expect(stateCalls).toBeGreaterThanOrEqual(1);
  });

  it("BUG 2: blocks add with 'Pick a voice channel first' when no channel and nothing playing", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }, wsRef) as unknown as typeof WebSocket);
    let playCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C1", name: "General" }], currentChannelId: null }) });
      if (url.endsWith("/api/guilds/G1/play")) { playCalls++; return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ queued: { id: "q1", title: "X" } }) }); }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    const box = (await screen.findByLabelText(/add a track/i)) as HTMLInputElement;
    // Both the input AND the submit button are disabled (busy) when there is no voice
    // target, so a real user could not type or submit.
    await waitFor(() => expect(box.disabled).toBe(true));
    expect((screen.getByRole("button", { name: /Queue it/i }) as HTMLButtonElement).disabled).toBe(true);
    // fireEvent bypasses the `disabled` attribute, so this also independently exercises
    // the app-level onPlay `noVoiceTarget` guard: even if submission slips through, the
    // backend is never hit and the prompt is shown.
    fireEvent.change(box, { target: { value: "https://youtu.be/abcdefghijk" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(screen.getByText(/Pick a voice channel first/i)).toBeTruthy());
    expect(playCalls).toBe(0); // never hit the backend
  });

  it("BUG 4: shows the admin-only move hint when an enqueue reports moveSuppressed", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({
      current: { ...qItem("aaa", "Now"), positionMs: 0, durationMs: 100000 },
      upcoming: [], history: [], paused: false, idleTimeoutSec: 300,
    }, wsRef) as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C2", name: "Lounge" }], currentChannelId: "C2" }) });
      if (url.endsWith("/api/guilds/G1/play")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ queued: { id: "q1", title: "My Song" }, moveSuppressed: { requested: "C2", actual: "C1" } }) });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    const box = (await screen.findByLabelText(/add a track/i)) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: "https://youtu.be/abcdefghijk" } });
    fireEvent.submit(box.closest("form")!);
    await waitFor(() => expect(screen.getByText(/Queued: My Song — only an admin can move the bot/i)).toBeTruthy());
  });

  it("load playlist: forwards the current voiceChannelId so the bot connects + plays", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }, wsRef) as unknown as typeof WebSocket);
    let loadBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C1", name: "General" }], currentChannelId: "C1" }) });
      if (url.endsWith("/api/guilds/G1/playlists")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ playlists: [{ name: "chill", trackCount: 3, savedAt: 1000 }] }) });
      if (url.includes("/playlists/chill/load")) { loadBody = String(init?.body); return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, queued: 3 }) }); }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    // The current channel (C1) auto-selects; click Load on the "chill" playlist.
    const loadBtn = await screen.findByRole("button", { name: /Load chill/i });
    fireEvent.click(loadBtn);
    await waitFor(() => expect(screen.getByText(/Loaded 3 tracks from chill/i)).toBeTruthy());
    expect(JSON.parse(loadBody!)).toEqual({ voiceChannelId: "C1" }); // forwarded the channel
  });

  it("load playlist: surfaces the no_voice_channel error via the banner", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }, wsRef) as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      // No current channel and a channel list present, but the user never picks one, so the
      // panel's noVoiceTarget guard fires before any backend call (mirrors play/pick).
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C1", name: "General" }], currentChannelId: null }) });
      if (url.endsWith("/api/guilds/G1/playlists")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ playlists: [{ name: "chill", trackCount: 3, savedAt: 1000 }] }) });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    const loadBtn = await screen.findByRole("button", { name: /Load chill/i });
    fireEvent.click(loadBtn);
    await waitFor(() => expect(screen.getByText(/Pick a voice channel first/i)).toBeTruthy());
  });

  it("bulk-queue: surfaces ONE aggregated summary banner (not N racing banners) and queues IN ORDER", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({
      current: { ...qItem("aaa", "Now"), positionMs: 0, durationMs: 100000 },
      upcoming: [], history: [], paused: false, idleTimeoutSec: 300,
    }, wsRef) as unknown as typeof WebSocket);
    const pickBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ channels: [{ id: "C1", name: "General" }], currentChannelId: "C1" }) });
      if (url.includes("/api/guilds/G1/play")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ videoId: "v1", title: "One", channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null }, { videoId: "v2", title: "Two", channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null }] }) });
      if (url.endsWith("/api/guilds/G1/pick")) { pickBodies.push(String(init?.body)); return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ queued: { id: "q", title: "t" } }) }); }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    const box = (await screen.findByLabelText(/add a track/i)) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: "two songs" } });
    fireEvent.submit(box.closest("form")!);
    // Picker appears; select both then queue.
    await screen.findByText(/pick the exact track/i);
    fireEvent.click(screen.getByText("Two"));
    fireEvent.click(screen.getByText("One"));
    fireEvent.click(screen.getByRole("button", { name: /queue 2 selected/i }));
    // ONE summary banner for the batch (not two separate "Queued: t" banners).
    await waitFor(() => expect(screen.getByText(/Queued 2 tracks/i)).toBeTruthy());
    // Picks were issued sequentially in candidate display order (v1 before v2).
    expect(pickBodies.map((b) => JSON.parse(b).videoId)).toEqual(["v1", "v2"]);
  });

  it("voice channels: surfaces an error banner and a retry affordance when the fetch fails", async () => {
    const wsRef: { current: { deliver: (s: unknown) => void } | null } = { current: null };
    vi.stubGlobal("WebSocket", makeFakeWS({ current: null, upcoming: [], history: [], paused: false, idleTimeoutSec: 300 }, wsRef) as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/me")) return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "Booth" }] }) });
      if (url.includes("/voice-channels")) return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: "boom" }) });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ current: null, upcoming: [], history: [], paused: false }) });
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Couldn't load voice channels/i)).toBeTruthy());
    // The picker still renders (does not vanish), with a recoverable placeholder + retry.
    const select = (await screen.findByRole("combobox", { name: /^voice channel$/i })) as HTMLSelectElement;
    expect(select).toBeTruthy();
    screen.getByText(/couldn't load — retry/i);
    screen.getByRole("button", { name: /retry loading voice channels/i });
  });
});
