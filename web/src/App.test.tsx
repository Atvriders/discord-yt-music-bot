// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "./components/App.js";

afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("shows the login gate when /api/me is unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "unauthenticated" }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Continue with Discord/i)).toBeTruthy());
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
