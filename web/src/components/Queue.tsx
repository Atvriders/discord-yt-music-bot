import type { QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";
import { Thumb } from "./Thumb.js";

export function Queue({ items, onRemove, onReorder }: {
  items: QueueItem[]; onRemove: (itemId: string) => void; onReorder: (itemId: string, toIndex: number) => void;
}) {
  return (
    <section className="card reveal p-5 sm:p-6" style={{ animationDelay: "180ms" }}>
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">Up next</p>
        <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>{items.length} queued</span>
      </div>
      {items.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--color-ink-faint)" }}>The queue is empty.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={it.id} className="group flex items-center gap-3 rounded-xl px-3 py-2.5"
              style={{ transition: "background .2s" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <span className="font-mono text-xs w-6 text-right" style={{ color: "var(--color-ink-faint)" }}>{i + 1}</span>
              {/* Thumb renders a placeholder (no broken <img src="">) when the url is null,
                  avoiding a spurious same-origin GET for every thumbnail-less queue item. */}
              <Thumb url={it.meta.thumbnailUrl} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={it.meta.title}>{it.meta.title}</p>
                <p className="truncate text-xs" style={{ color: "var(--color-ink-faint)" }}>
                  {it.meta.channel} · <span className="font-mono">{fmtTime(it.meta.durationSec)}</span> · {it.requester.displayName}
                </p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                <button aria-label="Move up" disabled={i === 0} onClick={() => onReorder(it.id, i - 1)}
                  className="pill pill-ghost" style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}>▲</button>
                <button aria-label="Move down" disabled={i === items.length - 1} onClick={() => onReorder(it.id, i + 1)}
                  className="pill pill-ghost" style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}>▼</button>
                <button aria-label={`Remove ${it.meta.title}`} onClick={() => onRemove(it.id)}
                  className="pill pill-ghost" style={{ padding: "0.35rem 0.7rem", fontSize: "0.8rem" }}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
