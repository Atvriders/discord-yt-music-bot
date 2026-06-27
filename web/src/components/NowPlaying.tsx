import { useEffect, useState } from "react";
import type { CurrentItem } from "../types.js";
import { fmtTime } from "../lib/format.js";

// Display-only progress indicator. We extrapolate the elapsed position between
// WS state updates so the bar MOVES smoothly. NOTE: this is purely visual —
// click-to-seek is intentionally out of scope (real seeking requires server-side
// audio re-streaming, which the player does not support).
function useDisplayedMs(positionMs: number, durationMs: number, paused: boolean, receivedAt: number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (paused) return;
    const iv = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(iv);
  }, [paused, receivedAt]);
  const raw = paused ? positionMs : positionMs + (Date.now() - receivedAt);
  const upper = durationMs > 0 ? durationMs : Infinity;
  return Math.max(0, Math.min(raw, upper));
}

export function NowPlaying({
  item,
  paused = false,
  receivedAt = 0,
}: {
  item: CurrentItem | null;
  paused?: boolean;
  receivedAt?: number;
}) {
  const displayedMs = useDisplayedMs(item?.positionMs ?? 0, item?.durationMs ?? 0, paused, receivedAt);

  if (!item) {
    return (
      <section className="card hero-glow reveal p-8" style={{ animationDelay: "80ms" }}>
        <p className="eyebrow">Now playing</p>
        <p className="font-display text-3xl mt-3" style={{ color: "var(--color-ink-dim)" }}>Nothing is playing.</p>
        <p className="mt-2 text-sm" style={{ color: "var(--color-ink-faint)" }}>Queue a YouTube link or search below to start the set.</p>
      </section>
    );
  }
  const { meta, requester, durationMs } = item;
  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (displayedMs / durationMs) * 100)) : 0;
  const elapsedLabel = fmtTime(displayedMs / 1000);
  const durationLabel = durationMs > 0 ? fmtTime(durationMs / 1000) : "live feed";
  return (
    <section className="card hero-glow reveal p-7 sm:p-8" style={{ animationDelay: "80ms" }}>
      <div className="relative z-10 flex gap-6">
        <div className="shrink-0 relative">
          <img src={meta.thumbnailUrl ?? ""} alt="" width={132} height={132}
            className="rounded-2xl object-cover" style={{ width: 132, height: 132, boxShadow: "0 8px 24px -10px rgba(0,0,0,0.6)" }} />
          <span className="absolute inset-0 rounded-2xl" style={{ boxShadow: "inset 0 0 0 1px var(--color-line)" }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>● Now playing</p>
          <h1 className="font-display text-3xl sm:text-4xl leading-tight mt-2 truncate" title={meta.title}>{meta.title}</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-ink-dim)" }}>{meta.channel}</p>
          <div
            className="vu mt-5"
            role="progressbar"
            aria-label="Playback progress"
            aria-valuemin={0}
            aria-valuemax={durationMs > 0 ? Math.round(durationMs / 1000) : undefined}
            aria-valuenow={Math.round(displayedMs / 1000)}
          >
            <span data-testid="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between mt-2 font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
            <span>{elapsedLabel}</span><span>{durationLabel}</span>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <img src={requester.avatarUrl} alt="" width={22} height={22} className="rounded-full" />
            <span className="text-xs" style={{ color: "var(--color-ink-dim)" }}>
              requested by <strong style={{ color: "var(--color-ink)" }}>{requester.displayName}</strong>
              <span className="font-mono" style={{ color: "var(--color-ink-faint)" }}> · {requester.source}</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
