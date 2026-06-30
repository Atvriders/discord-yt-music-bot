import type { AutoplaySource, CurrentItem, QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";
import { Thumb } from "./Thumb.js";

const AUTOPLAY_SOURCE_LABELS: Record<AutoplaySource, string> = {
  radio: "Radio / Mix",
  artist: "Artist",
};

/**
 * The Auto-discover console toggle for the queue header: a real accessible switch
 * (role="switch" + aria-checked) wired to the existing `autoplay` setting, with the
 * source picker (Radio vs Artist) lighting up only while it is engaged. Styled to the
 * Late-Night Studio deck — an ember "lamp" track + a sliding cream handle. Flipping it
 * posts the setting through `onToggle`, which threads to POST /settings in App.
 */
function AutoDiscover({
  autoplay,
  autoplaySource,
  onToggle,
}: {
  autoplay: boolean;
  autoplaySource: AutoplaySource;
  onToggle: (patch: { autoplay?: boolean; autoplaySource?: AutoplaySource }) => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5"
      title="Auto-discover: when the queue runs low, keep playing by pulling more tracks from YouTube — its related/Mix feed (Radio) or a search by the last track's artist. Keyed on the last song, not a precise genre match."
    >
      <span className="eyebrow" style={{ color: autoplay ? "var(--color-ember-soft)" : undefined }}>
        Auto-discover
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={autoplay}
        aria-label="Auto-discover"
        onClick={() => onToggle({ autoplay: !autoplay })}
        // A machined deck switch: a recessed track whose lamp warms to ember when engaged,
        // with a sliding cream handle. Uses the global ember tokens so it reads as part of
        // the console face. Focus ring comes from the inset box-shadow on :focus-visible.
        style={{
          position: "relative",
          width: "2.6rem",
          height: "1.4rem",
          flexShrink: 0,
          borderRadius: "var(--radius-pill)",
          border: "1px solid var(--color-line)",
          background: autoplay
            ? "linear-gradient(180deg, var(--color-ember-soft), var(--color-ember))"
            : "rgba(0,0,0,0.3)",
          boxShadow: autoplay
            ? "0 0 10px rgba(255,0,0,0.45), inset 0 1px 2px rgba(0,0,0,0.35)"
            : "inset 0 1px 3px rgba(0,0,0,0.5)",
          cursor: "pointer",
          transition: "background var(--dur-fast) var(--ease-mech), box-shadow var(--dur-fast) var(--ease-mech)",
          padding: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: "50%",
            left: autoplay ? "calc(100% - 1.18rem)" : "0.12rem",
            width: "1.06rem",
            height: "1.06rem",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-ink)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.6)",
            transform: "translateY(-50%)",
            transition: "left var(--dur-fast) var(--ease-mech)",
          }}
        />
      </button>
      <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
        {autoplay ? "ON" : "OFF"}
      </span>
      {/* Source picker is meaningful only while auto-discover is engaged. */}
      {autoplay && (
        <label className="flex items-center gap-1.5" title="Radio = YouTube's related/Mix feed for the last track. Artist = a search by the last track's channel/artist name (best-effort, not a verified discography).">
          <span className="eyebrow">Source</span>
          <select
            aria-label="Auto-discover source"
            value={autoplaySource}
            onChange={(e) => onToggle({ autoplaySource: e.target.value as AutoplaySource })}
            className="bg-transparent px-2 py-1 text-xs font-mono tracking-tight"
            style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }}
          >
            {(Object.keys(AUTOPLAY_SOURCE_LABELS) as AutoplaySource[]).map((s) => (
              <option key={s} value={s} style={{ background: "var(--color-raised)", color: "var(--color-ink)" }}>
                {AUTOPLAY_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/**
 * Total remaining listen time = sum of upcoming track durations + the remaining of the
 * current track. Unknown (null) durations count as 0 so the readout is always a real
 * time, never "—:—"/NaN. Returns whole seconds for fmtTime.
 */
function totalQueueSec(items: QueueItem[], current: CurrentItem | null): number {
  const upcoming = items.reduce((sum, it) => sum + (it.meta.durationSec ?? 0), 0);
  const remainingMs = current ? Math.max(0, current.durationMs - current.positionMs) : 0;
  return upcoming + Math.round(remainingMs / 1000);
}

export function Queue({
  items,
  current,
  onRemove,
  onReorder,
  onShuffle,
  onPlayNext,
  onJump,
  autoplay,
  autoplaySource,
  onToggleAutoplay,
}: {
  items: QueueItem[];
  current: CurrentItem | null;
  onRemove: (itemId: string) => void;
  onReorder: (itemId: string, toIndex: number) => void;
  onShuffle: () => void;
  onPlayNext: (itemId: string) => void;
  onJump: (itemId: string) => void;
  /** Whether auto-discover (autoplay) is engaged. Omit to hide the toggle entirely. */
  autoplay?: boolean;
  /** The auto-discover source (Radio vs Artist); only shown while engaged. */
  autoplaySource?: AutoplaySource;
  /** Persist an autoplay/autoplaySource patch (threads to POST /settings). */
  onToggleAutoplay?: (patch: { autoplay?: boolean; autoplaySource?: AutoplaySource }) => void;
}) {
  // The Auto-discover control renders only when the host wires the autoplay props (so the
  // standalone tests / older callers stay backwards-compatible without a toggle).
  const showAutoDiscover = autoplay !== undefined && onToggleAutoplay !== undefined;
  return (
    <section className="card p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <p className="eyebrow">Up next</p>
          {/* Auto-discover lives in the header so the queue running dry never means a hard
              stop — flip it and playback keeps going from YouTube's feed. */}
          {showAutoDiscover && (
            <AutoDiscover
              autoplay={autoplay!}
              autoplaySource={autoplaySource ?? "radio"}
              onToggle={onToggleAutoplay!}
            />
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Total remaining time: upcoming durations + the remaining of the current track.
              A mono "counter on the deck" readout. */}
          <span
            className="font-mono text-xs tabular-nums"
            style={{ color: "var(--color-ink-faint)", letterSpacing: "0.02em" }}
          >
            {items.length} queued ·{" "}
            <span title="Total remaining time" style={{ color: "var(--color-ink-dim)" }}>
              {fmtTime(totalQueueSec(items, current))}
            </span>
          </span>
          <button
            aria-label="Shuffle the queue"
            onClick={onShuffle}
            disabled={items.length < 2}
            className="pill pill-ghost"
            style={{ padding: "0.34rem 0.8rem", fontSize: "0.75rem" }}
          >
            ⇄ Shuffle
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <p
          className="mt-5 text-sm"
          style={{ color: "var(--color-ink-faint)", fontFamily: "var(--font-display)", fontStyle: "italic" }}
        >
          The queue is empty.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col">
          {items.map((it, i) => (
            <li
              key={it.id}
              className="group relative flex items-center gap-3 px-3 py-2.5"
              style={{
                borderRadius: "var(--radius-sm)",
                borderTop: i === 0 ? "none" : "1px solid var(--color-line)",
                transition: "background var(--dur-fast) var(--ease-mech), box-shadow var(--dur-fast) var(--ease-mech)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.025)";
                e.currentTarget.style.boxShadow = "inset 2px 0 0 0 var(--color-ember)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              {/* Position index — a mono "track number" on the console face. */}
              <span
                className="font-mono text-xs w-6 text-right tabular-nums"
                style={{ color: "var(--color-ink-faint)" }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              {/* Thumb renders a placeholder (no broken <img src="">) when the url is null,
                  avoiding a spurious same-origin GET for every thumbnail-less queue item. */}
              <Thumb url={it.meta.thumbnailUrl} size={40} />
              {/* The title block is itself the "jump to this track" control: click it to skip
                  straight here (drops the tracks before it). Kept as a button for a11y.
                  On hover the Fraunces title warms toward ember to signal it's clickable. */}
              <button
                type="button"
                aria-label={`Jump to ${it.meta.title}, play it now`}
                onClick={() => onJump(it.id)}
                className="min-w-0 flex-1 text-left"
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}
                onMouseEnter={(e) => {
                  const t = e.currentTarget.querySelector("[data-queue-title]") as HTMLElement | null;
                  if (t) t.style.color = "var(--color-ember-soft)";
                }}
                onMouseLeave={(e) => {
                  const t = e.currentTarget.querySelector("[data-queue-title]") as HTMLElement | null;
                  if (t) t.style.color = "var(--color-ink)";
                }}
              >
                <p
                  data-queue-title
                  className="font-display truncate text-sm"
                  title={it.meta.title}
                  style={{ color: "var(--color-ink)", transition: "color var(--dur-fast) var(--ease-mech)" }}
                >
                  {it.meta.title}
                </p>
                <p className="truncate text-xs mt-0.5" style={{ color: "var(--color-ink-dim)" }}>
                  {it.meta.channel} ·{" "}
                  <span className="font-mono tabular-nums" style={{ color: "var(--color-ink-faint)" }}>
                    {fmtTime(it.meta.durationSec)}
                  </span>{" "}
                  · {it.requester.displayName}
                </p>
              </button>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button aria-label={`Play next: ${it.meta.title}`} disabled={i === 0} onClick={() => onPlayNext(it.id)}
                  className="pill pill-ghost" style={{ padding: "0.3rem 0.6rem", fontSize: "0.7rem" }}>Play next</button>
                <button aria-label="Move up" disabled={i === 0} onClick={() => onReorder(it.id, i - 1)}
                  className="pill pill-ghost" style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}>▲</button>
                <button aria-label="Move down" disabled={i === items.length - 1} onClick={() => onReorder(it.id, i + 1)}
                  className="pill pill-ghost" style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}>▼</button>
                <button aria-label={`Remove ${it.meta.title}`} onClick={() => onRemove(it.id)}
                  className="pill pill-ghost" style={{ padding: "0.35rem 0.72rem", fontSize: "0.8rem" }}>
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
