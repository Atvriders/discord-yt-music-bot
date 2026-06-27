import { useCallback, useEffect, useRef, useState } from "react";
import type { CurrentItem } from "../types.js";
import { fmtAudio, fmtTime } from "../lib/format.js";
import { Visualizer } from "./Visualizer.js";

// Display progress indicator. We extrapolate the elapsed position between WS state
// updates so the bar MOVES smoothly. When `canSeek` is set the same bar becomes an
// interactive scrubber (click/drag to seek); otherwise it stays read-only.
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
  playing = false,
  receivedAt = 0,
  canSeek = false,
  onSeek,
}: {
  item: CurrentItem | null;
  paused?: boolean;
  /**
   * Drives the decorative visualizer only: animate the synthetic bars while a
   * track is actively playing, flatten/freeze them otherwise. NOT real audio.
   */
  playing?: boolean;
  receivedAt?: number;
  /** Whether the viewer may scrub. When false the bar is read-only. */
  canSeek?: boolean;
  /** Seek handler; receives the target position in ms. */
  onSeek?: (positionMs: number) => void;
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
  const audioLabel = fmtAudio(item.audio);
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
          {audioLabel && (
            <p className="mt-2 font-mono text-xs tracking-wide" style={{ color: "var(--color-ink-faint)" }}>
              {audioLabel}
            </p>
          )}
          <div className="mt-4"><Visualizer playing={playing} /></div>
          <ProgressBar
            durationMs={durationMs}
            displayedMs={displayedMs}
            canSeek={canSeek}
            onSeek={onSeek}
          />
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

interface ProgressBarProps {
  /** Track duration in ms (0/undefined for a live stream — not seekable). */
  durationMs: number;
  /** Server-extrapolated elapsed position in ms (what the bar renders when not dragging). */
  displayedMs: number;
  canSeek: boolean;
  onSeek?: (positionMs: number) => void;
}

/**
 * Progress / scrub bar. Read-only by default (role="progressbar"); when `canSeek` and the
 * track has a known duration, the same bar becomes an interactive slider — click anywhere to
 * seek, or drag the handle to scrub. While dragging we show the drag target locally so the UI
 * feels responsive; the real position re-syncs from the server once the seek lands.
 *
 * Seeking triggers a brief audible gap server-side while ffmpeg re-opens the cached file at
 * the new offset.
 */
function ProgressBar({ durationMs, displayedMs, canSeek, onSeek }: ProgressBarProps) {
  const interactive = canSeek && durationMs > 0;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragMs, setDragMs] = useState<number | null>(null);

  const posFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || durationMs <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      return Math.max(0, Math.min(1, ratio)) * durationMs;
    },
    [durationMs],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive) return;
      e.preventDefault();
      draggingRef.current = true;
      setDragMs(posFromClientX(e.clientX));
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [interactive, posFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setDragMs(posFromClientX(e.clientX));
    },
    [posFromClientX],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const target = Math.round(posFromClientX(e.clientX));
      setDragMs(null);
      onSeek?.(target);
    },
    [posFromClientX, onSeek],
  );

  const shownMs = dragMs ?? displayedMs;
  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (shownMs / durationMs) * 100)) : 0;
  const elapsedLabel = fmtTime(shownMs / 1000);
  const durationLabel = durationMs > 0 ? fmtTime(durationMs / 1000) : "live feed";

  return (
    <div className="mt-5">
      <div
        ref={trackRef}
        className="vu"
        role={interactive ? "slider" : "progressbar"}
        aria-label={interactive ? "Seek" : "Playback progress"}
        aria-valuemin={0}
        aria-valuemax={durationMs > 0 ? Math.round(durationMs / 1000) : undefined}
        aria-valuenow={Math.round(shownMs / 1000)}
        style={{
          position: "relative",
          cursor: interactive ? "pointer" : undefined,
          touchAction: interactive ? "none" : undefined,
          overflow: interactive ? "visible" : undefined,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span data-testid="progress-fill" style={{ width: `${pct}%` }} />
        {interactive && (
          <span
            data-testid="seek-handle"
            aria-hidden
            style={{
              position: "absolute",
              top: "50%",
              left: `${pct}%`,
              transform: "translate(-50%, -50%)",
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "var(--color-ember-soft, #e0a052)",
              boxShadow: "0 0 0 3px rgba(0,0,0,0.35)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
      <div className="flex items-center justify-between mt-2 font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
        <span>{elapsedLabel}</span><span>{durationLabel}</span>
      </div>
    </div>
  );
}
