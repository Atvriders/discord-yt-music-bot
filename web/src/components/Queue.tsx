import type { QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";

export function Queue({ items, onRemove }: { items: QueueItem[]; onRemove: (itemId: string) => void }) {
  return (
    <section className="card reveal p-5 sm:p-6" style={{ animationDelay: "180ms" }}>
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">Up next</p>
        <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>{items.length} queued</span>
      </div>
      {items.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--color-ink-faint)" }}>Nothing waiting. The night is young.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={it.id} className="group flex items-center gap-3 rounded-xl px-3 py-2.5"
              style={{ transition: "background .2s" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <span className="font-mono text-xs w-6 text-right" style={{ color: "var(--color-ink-faint)" }}>{i + 1}</span>
              <img src={it.meta.thumbnailUrl ?? ""} alt="" width={40} height={40} className="rounded-md object-cover" style={{ width: 40, height: 40 }} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={it.meta.title}>{it.meta.title}</p>
                <p className="truncate text-xs" style={{ color: "var(--color-ink-faint)" }}>
                  {it.meta.channel} · <span className="font-mono">{fmtTime(it.meta.durationSec)}</span> · {it.requester.displayName}
                </p>
              </div>
              <button aria-label={`Remove ${it.meta.title}`} onClick={() => onRemove(it.id)}
                className="pill pill-ghost opacity-0 group-hover:opacity-100" style={{ padding: "0.35rem 0.7rem", fontSize: "0.8rem" }}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
