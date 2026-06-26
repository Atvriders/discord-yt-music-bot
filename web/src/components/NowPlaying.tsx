import type { QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";

export function NowPlaying({ item }: { item: QueueItem | null }) {
  if (!item) {
    return (
      <section className="card hero-glow reveal p-8" style={{ animationDelay: "80ms" }}>
        <p className="eyebrow">On air</p>
        <p className="font-display text-3xl mt-3" style={{ color: "var(--color-ink-dim)" }}>Silence on the wire.</p>
        <p className="mt-2 text-sm" style={{ color: "var(--color-ink-faint)" }}>Queue a YouTube link or search below to start the set.</p>
      </section>
    );
  }
  const { meta, requester } = item;
  return (
    <section className="card hero-glow reveal p-7 sm:p-8" style={{ animationDelay: "80ms" }}>
      <div className="relative z-10 flex gap-6">
        <div className="shrink-0 relative">
          <img src={meta.thumbnailUrl ?? ""} alt="" width={132} height={132}
            className="rounded-2xl object-cover disc" style={{ width: 132, height: 132, boxShadow: "0 14px 40px -18px rgba(255,138,61,0.7)" }} />
          <span className="absolute inset-0 rounded-2xl" style={{ boxShadow: "inset 0 0 0 1px var(--color-line)" }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>● Now playing</p>
          <h1 className="font-display text-3xl sm:text-4xl leading-tight mt-2 truncate" title={meta.title}>{meta.title}</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-ink-dim)" }}>{meta.channel}</p>
          <div className="vu mt-5"><span style={{ width: "38%" }} /></div>
          <div className="flex items-center justify-between mt-2 font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
            <span>live feed</span><span>{fmtTime(meta.durationSec)}</span>
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
