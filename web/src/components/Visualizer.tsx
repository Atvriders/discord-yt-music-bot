/**
 * Visualizer — a purely DECORATIVE, SYNTHETIC equalizer-bar animation.
 *
 * IMPORTANT / HONEST CONSTRAINT: this does NOT analyze any real audio. The
 * Discord bot streams audio into a Discord voice channel, not into this web
 * page, so the browser has no audio signal to read. These bars are driven by
 * fixed per-bar CSS keyframe animations and reflect ONLY the snapshot
 * playing/paused state: they animate while a track is playing and
 * flatten/freeze when paused or stopped. The motion is faked for vibe.
 *
 * Respects prefers-reduced-motion: when reduced motion is requested the bars
 * render in a static, mid-height "frozen" pose with no animation.
 */

// Per-bar tuning: distinct animation duration + delay so the wave looks
// organic rather than a single synchronized pulse. Heights are CSS custom
// props consumed by the .viz-bar keyframes in index.css.
const BARS = [
  { dur: "0.62s", delay: "0s", peak: "100%", base: "30%" },
  { dur: "0.78s", delay: "0.09s", peak: "72%", base: "22%" },
  { dur: "0.55s", delay: "0.18s", peak: "92%", base: "34%" },
  { dur: "0.85s", delay: "0.04s", peak: "60%", base: "20%" },
  { dur: "0.7s", delay: "0.22s", peak: "100%", base: "28%" },
  { dur: "0.6s", delay: "0.12s", peak: "80%", base: "26%" },
  { dur: "0.9s", delay: "0.27s", peak: "66%", base: "18%" },
  { dur: "0.5s", delay: "0.07s", peak: "96%", base: "32%" },
  { dur: "0.75s", delay: "0.16s", peak: "70%", base: "24%" },
  { dur: "0.66s", delay: "0.02s", peak: "88%", base: "30%" },
] as const;

export function Visualizer({ playing }: { playing: boolean }) {
  return (
    <div role="presentation" aria-hidden="true">
      {/* Carved VU-meter housing: a recessed well machined into the faceplate,
          with an engraved silkscreen label + a mono "signal" readout that lights
          red when the deck is powered (playing). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.4rem",
        }}
      >
        <span className="eyebrow">Levels</span>
        <span
          className="font-mono"
          style={{
            fontSize: "0.62rem",
            letterSpacing: "0.04em",
            color: playing ? "var(--color-ember-soft)" : "var(--color-ink-faint)",
            textShadow: playing ? "0 0 8px rgba(255,0,0,.45)" : "none",
            transition: "color var(--dur-fast) var(--ease-mech)",
          }}
        >
          {playing ? "● SIGNAL" : "○ SILENT"}
        </span>
      </div>

      {/* The lit needle array. The recessed surround reads as carved into the
          plate; the bars (.viz / .viz-bar / .viz-on) are the backlit VU columns.
          Class names + per-bar custom props are unchanged so motion + tests hold. */}
      <div
        style={{
          padding: "0.45rem 0.7rem 0.3rem",
          borderRadius: "var(--radius-sm)",
          background: "linear-gradient(180deg, #0a0809, var(--color-sunken))",
          boxShadow: "var(--shadow-inset)",
        }}
      >
        <div
          className={`viz${playing ? " viz-on" : ""}`}
          role="presentation"
          aria-hidden="true"
          data-testid="visualizer"
          data-playing={playing ? "true" : "false"}
          title="Decorative visualizer (synthetic — not the real audio)"
        >
          {BARS.map((b, i) => (
            <span
              key={i}
              className="viz-bar"
              style={
                {
                  animationDuration: b.dur,
                  animationDelay: b.delay,
                  "--viz-peak": b.peak,
                  "--viz-base": b.base,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
