import { Grain } from "./Grain.js";

export function LoginGate() {
  return (
    <main className="min-h-full grid place-items-center px-6 py-12">
      <Grain />
      <div
        className="card hero-glow reveal max-w-md w-full p-10 text-center"
        style={{ animationDelay: "80ms" }}
      >
        {/* Engraved console deck label + lit power lamp */}
        <div className="flex items-center justify-between gap-3 mb-8">
          <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>
            YouTube Music Bot
          </p>
          <span
            className="font-mono"
            aria-hidden
            style={{
              fontSize: "0.6rem",
              letterSpacing: "0.14em",
              color: "var(--color-ink-faint)",
            }}
          >
            CH-01 / STEREO
          </span>
        </div>

        {/* Backlit VU array — the "amp is on" signature motif */}
        <div className="viz viz-on mx-auto" aria-hidden style={{ width: "9rem" }}>
          {[
            { d: "0.9s", g: "0ms", b: "26%", p: "84%" },
            { d: "1.1s", g: "120ms", b: "18%", p: "100%" },
            { d: "0.8s", g: "60ms", b: "34%", p: "72%" },
            { d: "1.0s", g: "200ms", b: "22%", p: "96%" },
            { d: "1.2s", g: "90ms", b: "30%", p: "66%" },
            { d: "0.95s", g: "150ms", b: "20%", p: "90%" },
          ].map((bar, i) => (
            <span
              key={i}
              className="viz-bar"
              style={{
                animationDuration: bar.d,
                animationDelay: bar.g,
                ["--viz-base" as string]: bar.b,
                ["--viz-peak" as string]: bar.p,
              }}
            />
          ))}
        </div>

        <h1
          className="font-display text-4xl mt-7 leading-tight"
          style={{ color: "var(--color-ink)" }}
        >
          Control your music.
        </h1>
        <p className="mt-4 text-sm" style={{ color: "var(--color-ink-dim)" }}>
          It plays the real audio straight from the exact YouTube video you link — never a re-uploaded or &ldquo;mirror&rdquo; audio track. Sign in with Discord to take the controls — only servers you belong to will appear.
        </p>

        <a className="pill pill-primary mt-8 justify-center w-full" href="/auth/login">
          <span aria-hidden>◈</span> Continue with Discord
        </a>

        {/* Console signature line in mono — reads as a counter on the deck */}
        <p
          className="font-mono mt-6"
          style={{
            fontSize: "0.62rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--color-ink-faint)",
          }}
        >
          <span aria-hidden style={{ color: "var(--color-ember-soft)" }}>●</span>{" "}
          Exact-link playback only
        </p>
      </div>
    </main>
  );
}
