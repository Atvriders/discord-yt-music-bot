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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ user: { id: "1", username: "dj", avatarUrl: "" }, guilds: [{ id: "G1", name: "The Booth" }] }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByText("The Booth")).toBeTruthy());
  });
});
