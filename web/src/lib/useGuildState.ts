// Per-(bot, guild) live state over a WebSocket. The server emits a "state" frame on every
// change. This hook owns the socket lifecycle: it (re)subscribes to the active bot+guild,
// and — critically — survives the socket being dropped when the tab is backgrounded by
// a phone/laptop. On an unexpected close it auto-reconnects with exponential backoff,
// and it reconnects immediately when the tab becomes visible again or the network
// comes back online, re-sending the subscribe so state resumes without a manual refresh.
import { useCallback, useEffect, useReducer } from "react";
import type { Snapshot } from "../types.js";
import { wsUrl } from "./api.js";

export interface WsState {
  snapshot: Snapshot | null;
  status: "connecting" | "live" | "forbidden" | "closed";
  // Local epoch-ms the latest state snapshot arrived — used to extrapolate the
  // moving progress bar between WS updates.
  receivedAt: number;
  lastError?: { title: string; reason: string; seq: number } | null;
  // Push a freshly-fetched snapshot into local state. Used when the WS isn't live
  // (so it won't deliver the update) but a REST mutation changed the queue.
  refresh: (snapshot: Snapshot) => void;
}
export const initialWsState: WsState = {
  snapshot: null,
  status: "connecting",
  receivedAt: 0,
  lastError: null,
  refresh: () => {},
};

// Backoff schedule: 1s, 2s, 4s, 8s, capped at ~15s. Index grows per failed attempt.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 15000;
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

export function applyWsMessage(prev: WsState, raw: string): WsState {
  let msg: { type?: string; state?: Snapshot; title?: string; reason?: string };
  try { msg = JSON.parse(raw); } catch { return prev; }
  if (msg.type === "state" && msg.state)
    return { ...prev, snapshot: msg.state, status: "live", receivedAt: Date.now() };
  if (msg.type === "error" || msg.type === "revoked") return { ...prev, status: "forbidden" };
  if (msg.type === "trackError") {
    return {
      ...prev,
      lastError: {
        title: msg.title ?? "track",
        reason: msg.reason ?? "failed",
        seq: (prev.lastError?.seq ?? 0) + 1,
      },
    };
  }
  return prev;
}

type WsAction =
  | { raw: string }
  | { reset: true }
  | { closed: true }
  | { connecting: true }
  | { refresh: Snapshot };

function reduce(s: WsState, a: WsAction): WsState {
  if ("reset" in a) return initialWsState;
  if ("connecting" in a)
    return s.status === "forbidden" ? s : { ...s, status: "connecting" };
  if ("closed" in a)
    return { ...s, status: s.status === "forbidden" ? s.status : "closed" };
  if ("refresh" in a) return { ...s, snapshot: a.refresh, receivedAt: Date.now() };
  return applyWsMessage(s, a.raw);
}

export function useGuildState(botId: string | null, guildId: string | null): WsState {
  const [state, dispatch] = useReducer(reduce, initialWsState);
  const refresh = useCallback((snapshot: Snapshot) => dispatch({ refresh: snapshot }), []);

  useEffect(() => {
    if (!botId || !guildId) return;
    if (typeof WebSocket === "undefined") return;
    // Non-null locals so the nested connect() closure sees them as `string` (TS won't
    // carry the guard's narrowing into a hoisted function that captures the params).
    const activeBotId: string = botId;
    const activeGuildId: string = guildId;

    dispatch({ reset: true });

    // Mutable lifecycle state shared by the (re)connect closure and the cleanup.
    let unmounted = false;
    let socket: WebSocket | null = null;
    let attempt = 0; // failed-connection counter, drives the backoff schedule
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Permission errors are PERMANENT for this (bot, guild): once the server sends `error`
    // or `revoked`, reconnecting just gets rejected again. Latch a flag so every
    // reconnect entry point (backoff, visibilitychange, window online) stops
    // recreating sockets — otherwise a forbidden target loops forever, opening a new
    // socket each backoff interval. Reset per bot/guild change (the effect re-runs).
    let forbidden = false;

    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (unmounted || forbidden || retryTimer !== null) return;
      const delay = reconnectDelayMs(attempt);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    // We can't rely on removeEventListener (not all WS impls/tests expose it), so each
    // socket carries a `dead` flag its handlers check. Once a socket is replaced or torn
    // down it is marked dead and can never dispatch into a newer connection. Mirrors the
    // original hook, which likewise relied on close() rather than detaching listeners.
    type Tracked = WebSocket & { _dead?: boolean };

    function teardownSocket() {
      if (socket) {
        (socket as Tracked)._dead = true;
        try { socket.close(); } catch { /* ignore */ }
        socket = null;
      }
    }

    function connect() {
      if (unmounted) return;
      clearRetry();
      // Tear down any prior socket so we never run two in parallel.
      teardownSocket();
      dispatch({ connecting: true });
      // The bot + guild are carried in the query string (/ws?botId=&guildId=); the
      // subscribe frame below re-states them so the server can route the stream.
      const ws = new WebSocket(wsUrl(activeBotId, activeGuildId)) as Tracked;
      socket = ws;

      ws.addEventListener("open", () => {
        if (ws._dead) return;
        attempt = 0; // a healthy connection resets the backoff
        ws.send(JSON.stringify({ subscribe: activeGuildId, botId: activeBotId }));
      });
      ws.addEventListener("message", (e) => {
        if (ws._dead) return;
        const raw = String(e.data);
        // Latch the permanent-permission-error stop BEFORE dispatch so the close that
        // typically follows an error/revoked frame doesn't schedule a doomed reconnect.
        try {
          const type = (JSON.parse(raw) as { type?: string }).type;
          if (type === "error" || type === "revoked") forbidden = true;
        } catch { /* malformed frame — the reducer ignores it */ }
        dispatch({ raw });
      });
      const onDown = () => {
        if (ws._dead || ws !== socket) return; // a stale/replaced socket
        ws._dead = true;
        dispatch({ closed: true });
        scheduleReconnect();
      };
      ws.addEventListener("close", onDown);
      ws.addEventListener("error", onDown);
    }

    // Reconnect immediately (no backoff wait) when the user returns to the tab or the
    // network comes back — but only if we don't already have a live/connecting socket.
    const reconnectNow = () => {
      if (unmounted || forbidden) return;
      const ready = socket?.readyState;
      if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return;
      clearRetry();
      attempt = 0;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconnectNow);

    connect();

    return () => {
      unmounted = true;
      clearRetry();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconnectNow);
      teardownSocket();
    };
  }, [botId, guildId]);

  return { ...state, refresh };
}
