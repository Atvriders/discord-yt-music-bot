// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Cookies } from "./Cookies.js";
import { api, ApiError } from "../lib/api.js";
import type { CookieHealth } from "../types.js";

/**
 * The console's UI contract. The load-bearing behaviours, in order of how badly each one bites:
 *
 *  - A server with no COOKIE_ADMIN_PASSWORD (404) renders NOTHING. Not a locked box, not a
 *    toggle — an ordinary guild member must never see an admin control advertising itself.
 *  - A configured-but-locked console shows only the password prompt, and only once the operator
 *    asks for it with #cookies. The hash is discoverability; the server is the boundary.
 *  - Health is read lazily and never displays a cookie.
 *  - A slow op locks the other buttons and always releases `busy`.
 */

const PASSWORD = "console-password";

const HEALTH: CookieHealth = {
  configured: true,
  source: "paste",
  updatedAt: Date.now() - 60_000,
  lastCheck: { at: Date.now() - 30_000, ok: true, reason: null },
  browserProfileAvailable: false,
};

function health(over: Partial<CookieHealth> = {}): CookieHealth {
  return { ...HEALTH, ...over };
}

beforeEach(() => {
  window.location.hash = "";
  sessionStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => cleanup());

/** Let the mount probe settle, so assertions run against the resolved gate. */
async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Cookies — the gate", () => {
  it("renders nothing at all when the console is not configured (404)", async () => {
    vi.spyOn(api, "cookies").mockRejectedValue(new ApiError(404, "cookie console is disabled"));
    const { container } = render(<Cookies />);
    await settled();
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("renders nothing while locked until the operator asks with #cookies", async () => {
    vi.spyOn(api, "cookies").mockRejectedValue(new ApiError(403, "password required"));
    const { container } = render(<Cookies />);
    await settled();
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("shows ONLY a password prompt when locked and revealed by hash", async () => {
    window.location.hash = "#cookies";
    vi.spyOn(api, "cookies").mockRejectedValue(new ApiError(403, "password required"));
    render(<Cookies />);
    await waitFor(() =>
      expect(screen.getByLabelText(/cookie console password/i)).toBeTruthy(),
    );
    // No health, no actions — nothing about the account is on screen.
    expect(screen.queryByRole("button", { name: /test now/i })).toBeNull();
    expect(screen.queryByText(/YouTube session/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /import from browser/i })).toBeNull();
  });

  it("unlocks on submit, stores the password per-tab, and sends it as x-cookie-admin", async () => {
    window.location.hash = "#cookies";
    const spy = vi
      .spyOn(api, "cookies")
      .mockRejectedValueOnce(new ApiError(403, "password required"))
      .mockResolvedValue(health());
    render(<Cookies />);
    const input = await screen.findByLabelText(/cookie console password/i);
    fireEvent.change(input, { target: { value: PASSWORD } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(screen.getByRole("button", { name: /cookie console/i })).toBeTruthy());
    expect(sessionStorage.getItem("ytbot.cookieAdmin")).toBe(PASSWORD);
    expect(spy).toHaveBeenLastCalledWith(PASSWORD);
  });

  it("drops a stored password the server has stopped accepting", async () => {
    sessionStorage.setItem("ytbot.cookieAdmin", "stale");
    window.location.hash = "#cookies";
    vi.spyOn(api, "cookies").mockRejectedValue(new ApiError(403, "password required"));
    render(<Cookies />);
    await waitFor(() => expect(sessionStorage.getItem("ytbot.cookieAdmin")).toBeNull());
    // …and the operator is shown the prompt again rather than a silently dead panel.
    expect(await screen.findByLabelText(/cookie console password/i)).toBeTruthy();
  });
});

describe("Cookies — the panel", () => {
  beforeEach(() => {
    sessionStorage.setItem("ytbot.cookieAdmin", PASSWORD);
  });

  it("does not read health until the panel is opened", async () => {
    const spy = vi.spyOn(api, "cookies").mockResolvedValue(health());
    render(<Cookies />);
    await waitFor(() => expect(screen.getByRole("button", { name: /cookie console/i })).toBeTruthy());
    // One call: the mount probe that decides whether the console exists here. Opening it is
    // what fetches again — a member's page load must not keep hitting a maintenance endpoint.
    const afterMount = spy.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /cookie console/i }));
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(afterMount));
  });

  it("reports a passing session, and offers no import button without a sidecar profile", async () => {
    vi.spyOn(api, "cookies").mockResolvedValue(health());
    render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));
    expect(await screen.findByText(/YouTube is accepting these cookies/i)).toBeTruthy();
    expect(screen.getByText(/^Passing$/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /import from browser/i })).toBeNull();
  });

  it("shows the import button only when the sidecar profile is really readable", async () => {
    vi.spyOn(api, "cookies").mockResolvedValue(health({ browserProfileAvailable: true }));
    render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));
    expect(await screen.findByRole("button", { name: /import from browser/i })).toBeTruthy();
  });

  it("flags a refusing session on the COLLAPSED toggle", async () => {
    vi.spyOn(api, "cookies").mockResolvedValue(
      health({ lastCheck: { at: Date.now(), ok: false, reason: "sign-in / bot check" } }),
    );
    render(<Cookies />);
    // Closed panel, and it still raises its hand — the operator should not have to open it.
    expect(await screen.findByText(/needs attention/i)).toBeTruthy();
  });

  it("saves a paste, clears the box on success, and never echoes what was pasted", async () => {
    const SECRET = "s3cr3t-SID-value-do-not-echo";
    vi.spyOn(api, "cookies").mockResolvedValue(health());
    const save = vi.spyOn(api, "cookiesSave").mockResolvedValue({ ok: true, reason: null });
    const { container } = render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));

    const box = await screen.findByLabelText(/paste new cookies/i);
    fireEvent.change(box, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: /save & apply/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(PASSWORD, SECRET));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
    expect(await screen.findByText(/Saved and applied/i)).toBeTruthy();
    // The pasted session is not held anywhere in the rendered console after it is applied.
    expect(container.textContent ?? "").not.toContain(SECRET);
  });

  it("keeps the paste when the save fails, so the operator does not have to re-copy it", async () => {
    vi.spyOn(api, "cookies").mockResolvedValue(health());
    vi.spyOn(api, "cookiesSave").mockResolvedValue({
      ok: false,
      reason: "no cookies found in that text",
    });
    render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));
    const box = await screen.findByLabelText(/paste new cookies/i);
    fireEvent.change(box, { target: { value: "not really cookies" } });
    fireEvent.click(screen.getByRole("button", { name: /save & apply/i }));

    expect(await screen.findByText(/no cookies found in that text/i)).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("not really cookies");
  });

  it("renders a success ALONGSIDE the server's warning, not instead of it", async () => {
    const warning = "saved, but this jar carries no YouTube sign-in cookies (SID / __Secure-1PSID)";
    vi.spyOn(api, "cookies").mockResolvedValue(health());
    vi.spyOn(api, "cookiesSave").mockResolvedValue({ ok: true, reason: null, warning });
    render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));
    fireEvent.change(await screen.findByLabelText(/paste new cookies/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save & apply/i }));

    expect(await screen.findByText(/Saved and applied/i)).toBeTruthy();
    expect(screen.getByText(new RegExp(warning.slice(0, 30), "i"))).toBeTruthy();
  });

  it("surfaces an import failure verbatim — the reason names the next action", async () => {
    const reason =
      "that profile is not signed in to YouTube — sign in inside the browser sidecar, wait ~30s";
    vi.spyOn(api, "cookies").mockResolvedValue(health({ browserProfileAvailable: true }));
    vi.spyOn(api, "cookiesImport").mockResolvedValue({ ok: false, reason });
    render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));
    fireEvent.click(await screen.findByRole("button", { name: /import from browser/i }));
    expect(await screen.findByText(/not signed in to YouTube/i)).toBeTruthy();
  });

  it("locks the other buttons while an op runs, then releases them", async () => {
    vi.spyOn(api, "cookies").mockResolvedValue(health());
    let finish: (v: { ok: boolean; reason: null }) => void = () => {};
    vi.spyOn(api, "cookiesTest").mockReturnValue(
      new Promise((res) => {
        finish = res;
      }),
    );
    render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));
    const test = await screen.findByRole("button", { name: /test now/i });
    fireEvent.click(test);

    // Honest pending copy, and the paste button is locked out for the duration.
    expect(await screen.findByText(/Running a real extraction against YouTube/i)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /save & apply/i }) as HTMLButtonElement).disabled).toBe(true),
    );

    await act(async () => {
      finish({ ok: true, reason: null });
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /test now/i }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("releases busy even when the request rejects", async () => {
    vi.spyOn(api, "cookies").mockResolvedValue(health());
    vi.spyOn(api, "cookiesTest").mockRejectedValue(new ApiError(500, "internal_error"));
    render(<Cookies />);
    fireEvent.click(await screen.findByRole("button", { name: /cookie console/i }));
    fireEvent.click(await screen.findByRole("button", { name: /test now/i }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /test now/i }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
