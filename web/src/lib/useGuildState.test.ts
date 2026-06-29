// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGuildState, reconnectDelayMs } from "./useGuildState.js";

// Minimal controllable WebSocket double. Tracks every instance so a test can assert
// that a new socket was created on reconnect, and lets us drive open/close/message.
class FakeWS {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  static instances: FakeWS[] = [];

  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, ((e: unknown) => void)[]> = {};

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  addEventListener(ev: string, cb: (e: unknown) => void) {
    (this.listeners[ev] ??= []).push(cb);
  }
  removeEventListener(ev: string, cb: (e: unknown) => void) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== cb);
  }
  private emit(ev: string, e: unknown) {
    for (const cb of [...(this.listeners[ev] ?? [])]) cb(e);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  // helpers
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  drop() {
    this.readyState = 3;
    this.emit("close", {});
  }
  message(data: string) {
    this.emit("message", { data });
  }
  error() {
    this.readyState = 3;
    this.emit("error", {});
    this.emit("close", {});
  }
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  vi.useFakeTimers();
  // jsdom defaults visibility to "visible"; let tests override per-case.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
let visibility: DocumentVisibilityState = "visible";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  visibility = "visible";
});

describe("reconnectDelayMs", () => {
  it("follows 1s,2s,4s,8s and caps at ~15s", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(3)).toBe(8000);
    expect(reconnectDelayMs(10)).toBe(15000); // capped
  });
});

describe("useGuildState reconnect", () => {
  it("opens a socket and subscribes to the active guild", () => {
    renderHook(() => useGuildState("g1"));
    expect(FakeWS.instances).toHaveLength(1);
    act(() => FakeWS.instances[0]!.open());
    expect(FakeWS.instances[0]!.sent).toContain(JSON.stringify({ subscribe: "g1" }));
  });

  it("schedules a reconnect on close: a NEW socket is created after the backoff", () => {
    const { result } = renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    expect(FakeWS.instances).toHaveLength(1);

    act(() => FakeWS.instances[0]!.drop());
    // The drop marks us closed and schedules — no new socket yet.
    expect(result.current.status).toBe("closed");
    expect(FakeWS.instances).toHaveLength(1);

    // After the first backoff (1s) a fresh socket is created and re-subscribes.
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWS.instances).toHaveLength(2);
    act(() => FakeWS.instances[1]!.open());
    expect(FakeWS.instances[1]!.sent).toContain(JSON.stringify({ subscribe: "g1" }));
  });

  it("reconnects immediately when the tab becomes visible while closed", () => {
    renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    act(() => FakeWS.instances[0]!.drop());
    expect(FakeWS.instances).toHaveLength(1);

    // Going visible should reconnect right away, without waiting for the backoff timer.
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(FakeWS.instances).toHaveLength(2);
  });

  it("does not reconnect on visibility when the socket is still open (no duplicate)", () => {
    renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("stops reconnecting and tears down on unmount (no leaked timers/sockets)", () => {
    const { unmount } = renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    act(() => FakeWS.instances[0]!.drop()); // schedules a retry
    unmount();
    act(() => vi.advanceTimersByTime(60000));
    // No reconnect happened after unmount.
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("delivers a 'message' state frame through the hook: status goes live and snapshot updates", () => {
    const snap = {
      current: null, upcoming: [], history: [], paused: false,
      idleTimeoutSec: 300, crossfadeSec: 0, normalizeLoudness: false,
      repeat: "off", autoplay: false, autoplaySource: "radio", maxTrackDurationSec: 0,
    };
    const { result } = renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    act(() => FakeWS.instances[0]!.message(JSON.stringify({ type: "state", state: snap })));
    // The hook wired the listener, extracted String(e.data), and reduced it into state.
    expect(result.current.status).toBe("live");
    expect(result.current.snapshot).toEqual(snap);
    expect(result.current.receivedAt).toBeGreaterThan(0);
  });

  it("reconnects on a socket 'error' event (shares the onDown path)", () => {
    const { result } = renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    act(() => FakeWS.instances[0]!.error());
    expect(result.current.status).toBe("closed");
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWS.instances).toHaveLength(2);
    act(() => FakeWS.instances[1]!.open());
    expect(FakeWS.instances[1]!.sent).toContain(JSON.stringify({ subscribe: "g1" }));
  });

  it("reconnects immediately on a window 'online' event while closed", () => {
    renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    act(() => FakeWS.instances[0]!.drop());
    expect(FakeWS.instances).toHaveLength(1);
    // 'online' should reconnect right away (no backoff wait).
    act(() => window.dispatchEvent(new Event("online")));
    expect(FakeWS.instances).toHaveLength(2);
  });

  it("removes the 'online' listener on unmount (no leak / no reconnect after teardown)", () => {
    const { unmount } = renderHook(() => useGuildState("g1"));
    act(() => FakeWS.instances[0]!.open());
    act(() => FakeWS.instances[0]!.drop());
    unmount();
    act(() => window.dispatchEvent(new Event("online")));
    // The listener was detached: no extra socket is created.
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("increases the backoff across consecutive failures, and resets it after a healthy open", () => {
    renderHook(() => useGuildState("g1"));
    // Attempt 0: drop -> 1s -> socket 1.
    act(() => FakeWS.instances[0]!.drop());
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWS.instances).toHaveLength(2);
    // Attempt 1 (socket 1 never opened): drop -> needs 2s, not 1s.
    act(() => FakeWS.instances[1]!.drop());
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWS.instances).toHaveLength(2); // 1s is NOT enough now
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWS.instances).toHaveLength(3); // 2s total -> socket 2
    // A healthy open resets the counter: the NEXT drop backs off at 1s again.
    act(() => FakeWS.instances[2]!.open());
    act(() => FakeWS.instances[2]!.drop());
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWS.instances).toHaveLength(4);
  });

  it("creates no socket when guildId is null, and connects once on null -> 'g1'", () => {
    const { rerender } = renderHook(({ g }) => useGuildState(g), { initialProps: { g: null as string | null } });
    expect(FakeWS.instances).toHaveLength(0);
    rerender({ g: "g1" });
    expect(FakeWS.instances).toHaveLength(1);
    act(() => FakeWS.instances[0]!.open());
    expect(FakeWS.instances[0]!.sent).toContain(JSON.stringify({ subscribe: "g1" }));
  });

  it("on a g1 -> g2 switch, tears down the old socket and subscribes exactly one new socket to g2", () => {
    const { rerender } = renderHook(({ g }) => useGuildState(g), { initialProps: { g: "g1" } });
    act(() => FakeWS.instances[0]!.open());
    rerender({ g: "g2" });
    // Old socket closed, a single fresh socket created for g2.
    expect(FakeWS.instances[0]!.readyState).toBe(3);
    expect(FakeWS.instances).toHaveLength(2);
    act(() => FakeWS.instances[1]!.open());
    expect(FakeWS.instances[1]!.sent).toContain(JSON.stringify({ subscribe: "g2" }));
  });
});
