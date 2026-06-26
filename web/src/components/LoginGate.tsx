import { Grain } from "./Grain.js";

export function LoginGate() {
  return (
    <main className="min-h-full grid place-items-center px-6">
      <Grain />
      <div className="card hero-glow reveal max-w-md w-full p-10 text-center">
        <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>YouTube Music Bot</p>
        <h1 className="font-display text-4xl mt-3 leading-tight">The booth is locked.</h1>
        <p className="mt-3 text-sm" style={{ color: "var(--color-ink-dim)" }}>
          It plays the real audio straight from the exact YouTube video you link — never a re-uploaded or &ldquo;mirror&rdquo; audio track. Sign in with Discord to take the controls — only servers you belong to will appear.
        </p>
        <a className="pill pill-primary mt-7 justify-center w-full" href="/auth/login">
          <span aria-hidden>◈</span> Continue with Discord
        </a>
      </div>
    </main>
  );
}
