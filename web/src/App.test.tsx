// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { App } from "./components/App.js";

afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("shows the login gate when /api/me is unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "unauthenticated" }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Continue with Discord/i)).toBeTruthy());
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
