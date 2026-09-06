import { useEffect, useRef } from "react";
import { sampleLevels, type TrackLevels } from "../lib/useTrackLevels.js";

/**
 * Levels — a REAL spectrum meter for the track that is playing.
 *
 * The page has no audio to analyse: the bot streams into a Discord voice channel, not into this
 * browser. So the SERVER analyses the cached audio file into a per-band energy timeline (see
 * src/levels) and this reads that timeline at the current playback position. The bars are the
 * actual song — bass on the left, treble on the right — in step with what the channel hears.
 *
 * When there is no timeline (still downloading, a live stream, an analysis that failed) the
 * meter does NOT invent motion. It sits at a dim floor and says so, because a meter that dances
 * to nothing is worse than one that admits it has no signal.
 */

/** Bars across the meter. Must match BANDS in src/levels. */
const BARS = 40;

/**
 * Meter ballistics. Real VU hardware rises fast and falls slowly; matching that stops the bars
 * strobing on every transient and is most of what makes this read as an instrument.
 */
const ATTACK = 0.55;
const RELEASE = 0.14;

export function Visualizer({
  playing,
  levels,
  getPositionMs,
}: {
  /** Whether a track is actively playing — a paused deck holds its last reading. */
  playing: boolean;
  /** The analysed timeline for the current track, or null when none is available. */
  levels: TrackLevels | null;
  /** Live playback position, read per animation frame (never via React state). */
  getPositionMs: () => number;
}) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  // The values the bars are currently DISPLAYING, so ballistics can ease toward each new frame.
  const shownRef = useRef<Float32Array>(new Float32Array(BARS));
  // Kept in refs so the animation loop never restarts on a re-render (which would reset the
  // easing and make the meter stutter every time the panel updates).
  const levelsRef = useRef(levels);
  const playingRef = useRef(playing);
  const posRef = useRef(getPositionMs);
  levelsRef.current = levels;
  playingRef.current = playing;
  posRef.current = getPositionMs;

  const hasSignal = levels !== null;

  useEffect(() => {
    const reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    const frame = new Float32Array(BARS);
    let raf = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const paint = (): void => {
      const lv = levelsRef.current;
      const shown = shownRef.current;
      // A real reading, or the floor when there is nothing to read.
      const live = lv !== null && playingRef.current && sampleLevels(lv, posRef.current(), frame);
      for (let b = 0; b < BARS; b++) {
        const target = live ? (frame[b] ?? 0) : 0;
        const cur = shown[b] ?? 0;
        // Rise quickly, fall gently.
        shown[b] = cur + (target - cur) * (target > cur ? ATTACK : RELEASE);
        const el = barsRef.current[b];
        if (el) {
          // Reveal the column from the bottom. clip-path (not height) so this never triggers
          // layout, and not scaleY either — scaling would squash the amber→red gradient into
          // every column so a quiet band looked exactly as hot as a loud one. A small floor
          // keeps the meter reading as an instrument at rest rather than as an empty box.
          const v = 0.03 + (shown[b] ?? 0) * 0.97;
          el.style.clipPath = `inset(${((1 - v) * 100).toFixed(2)}% 0 0 0)`;
        }
      }
    };

    if (reduce) {
      // Honor the preference without going dark: refresh slowly instead of every frame.
      timer = setInterval(paint, 400);
      paint();
    } else {
      const loop = (): void => {
        paint();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer !== null) clearInterval(timer);
    };
  }, []);

  return (
    <div role="presentation" aria-hidden="true">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.35rem",
        }}
      >
        <span className="eyebrow">Levels</span>
        <span
          className="font-mono"
          data-testid="levels-readout"
          style={{
            fontSize: "0.6rem",
            letterSpacing: "0.04em",
            color: hasSignal && playing ? "var(--color-ember-soft)" : "var(--color-ink-faint)",
            textShadow: hasSignal && playing ? "0 0 8px rgba(255,0,0,.45)" : "none",
            transition: "color var(--dur-fast) var(--ease-mech)",
          }}
        >
          {/* Says what is true: whether these bars are reading the actual track. */}
          {!hasSignal ? "○ NO SIGNAL" : playing ? "● SIGNAL" : "○ HOLD"}
        </span>
      </div>
      <div className={`viz${hasSignal && playing ? " viz-on" : ""}`} data-testid="viz">
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            className="viz-bar"
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </div>
    </div>
  );
}
