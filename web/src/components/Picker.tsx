import { useState } from "react";
import type { TrackMeta } from "../types.js";
import { fmtTime } from "../lib/format.js";
import { Thumb } from "./Thumb.js";

// The exact-track picker, shared by AddBar and Discover. It is multi-select:
// each candidate row is toggle-selectable (highlight + checkmark, aria-pressed),
// and a primary "Queue selected (N)" button queues ALL selected candidates IN
// candidate display order via onQueueSelected, then clears the selection and
// calls onQueued (so the parent can close/reset the picker). Errors are surfaced
// by the parent's queue flow (the same status banner as a single pick).
export function Picker({
  candidates,
  onQueueSelected,
  onQueued,
  busy,
}: {
  candidates: TrackMeta[];
  /**
   * Queues every selected candidate, in candidate display order, and resolves to
   * whether at least one track was queued. Teardown (clearing the selection and
   * calling onQueued) is gated on that success so a failed batch keeps the candidates
   * mounted for retry.
   */
  onQueueSelected: (videoIds: string[]) => Promise<boolean> | void;
  /** Called after a successful queue so the parent can clear/close the picker. */
  onQueued?: () => void;
  /** When true (e.g. no voice target) the queue/selection controls are disabled. */
  busy?: boolean;
}) {
  // Selection is a Set of videoIds; order is always derived from `candidates`.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Re-entrancy guard: disable the controls while a queue is in flight.
  const [queuing, setQueuing] = useState(false);

  function toggle(videoId: string) {
    if (busy || queuing) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  async function queueSelected() {
    if (selected.size === 0 || busy || queuing) return;
    // Deliver in candidate display order, not click order.
    const ids = candidates.map((c) => c.videoId).filter((id) => selected.has(id));
    if (ids.length === 0) return;
    setQueuing(true);
    try {
      const result = await onQueueSelected(ids);
      // `void` (legacy single-pick) is treated as success; only an explicit `false`
      // (no track queued) keeps the picker open with the selection intact for retry.
      if (result !== false) {
        setSelected(new Set());
        onQueued?.();
      }
    } finally {
      setQueuing(false);
    }
  }

  const count = selected.size;
  const controlsDisabled = !!busy || queuing;

  return (
    <ul className="flex flex-col gap-1">
      <li className="flex items-center justify-between gap-2 px-1 pb-1">
        <span className="eyebrow">Pick the exact track</span>
        {count > 0 && (
          <button
            type="button"
            onClick={queueSelected}
            disabled={controlsDisabled}
            aria-label={`Queue ${count} selected track${count === 1 ? "" : "s"}`}
            className="pill pill-primary"
            style={{ padding: "0.3rem 0.7rem", fontSize: "0.8rem" }}
          >
            {queuing ? "Queuing…" : `Queue selected (${count})`}
          </button>
        )}
      </li>
      {candidates.map((c) => {
        const isSelected = selected.has(c.videoId);
        return (
          <li key={c.videoId}>
            <button
              type="button"
              aria-pressed={isSelected}
              disabled={controlsDisabled}
              onClick={() => toggle(c.videoId)}
              className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left"
              style={{
                transition: "background .15s",
                background: isSelected ? "rgba(255,255,255,0.10)" : "transparent",
                boxShadow: isSelected ? "inset 0 0 0 1px var(--color-accent, rgba(255,255,255,0.35))" : "none",
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.08)";
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = "transparent";
              }}
            >
              <Thumb url={c.thumbnailUrl} size={44} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{c.title}</span>
                <span className="block truncate text-xs" style={{ color: "var(--color-ink-faint)" }}>
                  {c.channel} · <span className="font-mono">{fmtTime(c.durationSec)}</span>
                </span>
              </span>
              {/* Selected-state checkmark badge. */}
              <span
                aria-hidden
                className="shrink-0 grid place-items-center rounded-full"
                style={{
                  width: 22,
                  height: 22,
                  border: "1px solid var(--color-line)",
                  background: isSelected ? "var(--color-accent, #5b8cff)" : "transparent",
                  color: isSelected ? "#fff" : "transparent",
                }}
              >
                {isSelected && (
                  <svg
                    data-testid="picker-check"
                    width={13}
                    height={13}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
