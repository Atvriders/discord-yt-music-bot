import { useEffect, useReducer } from "react";
import type { Snapshot } from "../types.js";

export interface WsState {
  snapshot: Snapshot | null;
  status: "connecting" | "live" | "forbidden" | "closed";
  lastError?: { title: string; reason: string; seq: number } | null;
}
export const initialWsState: WsState = { snapshot: null, status: "connecting", lastError: null };

export function applyWsMessage(prev: WsState, raw: string): WsState {
  let msg: { type?: string; state?: Snapshot; title?: string; reason?: string };
  try { msg = JSON.parse(raw); } catch { return prev; }
  if (msg.type === "state" && msg.state) return { ...prev, snapshot: msg.state, status: "live" };
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

export function useGuildState(guildId: string | null): WsState {
  const [state, dispatch] = useReducer(
    (s: WsState, a: { raw: string } | { reset: true } | { closed: true }): WsState =>
      "reset" in a ? initialWsState : "closed" in a ? { ...s, status: s.status === "forbidden" ? s.status : "closed" } : applyWsMessage(s, a.raw),
    initialWsState,
  );
  useEffect(() => {
    if (!guildId) return;
    if (typeof WebSocket === "undefined") return;
    dispatch({ reset: true });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ subscribe: guildId })));
    ws.addEventListener("message", (e) => dispatch({ raw: String(e.data) }));
    ws.addEventListener("close", () => dispatch({ closed: true }));
    return () => ws.close();
  }, [guildId]);
  return state;
}
