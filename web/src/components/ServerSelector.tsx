import type { Me } from "../types.js";

export function ServerSelector({ me, activeGuildId, onSelect, onLogout }: {
  me: Me; activeGuildId: string | null; onSelect: (id: string) => void; onLogout: () => void;
}) {
  return (
    <header
      className="card flex flex-wrap items-center gap-x-5 gap-y-3 justify-between"
      style={{ padding: "0.85rem 1.1rem" }}
    >
      <div className="flex items-center gap-4 min-w-0">
        {/* Engraved brand plate: the console wordmark in lit-red Fraunces. */}
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "1.75rem",
              height: "1.75rem",
              borderRadius: "var(--radius-sm)",
              flex: "0 0 auto",
              color: "#fff",
              fontSize: "0.7rem",
              background:
                "linear-gradient(180deg, var(--color-ember-soft), var(--color-ember) 45%, var(--color-ember-deep))",
              boxShadow: "var(--glow-red)",
            }}
          >
            ▶
          </span>
          <span
            className="font-display text-xl"
            style={{ color: "var(--color-ember-soft)", textShadow: "var(--glow-red-soft)" }}
          >
            YouTube Music Bot
          </span>
        </div>

        {/* Vertical seam separating the brand plate from the server bank. */}
        <span
          aria-hidden="true"
          className="hidden sm:block"
          style={{ width: 1, height: "1.6rem", background: "var(--color-line)", flex: "0 0 auto" }}
        />

        {/* Server bank: tactile console keys, the active one lit red. */}
        <div className="flex flex-col gap-1.5 min-w-0">
          <span className="eyebrow">Server</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {me.guilds.length === 0 && (
              <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                No shared servers.
              </span>
            )}
            {me.guilds.map((g) => (
              <button
                key={g.id}
                onClick={() => onSelect(g.id)}
                className="pill"
                aria-pressed={g.id === activeGuildId}
                style={
                  g.id === activeGuildId
                    ? { borderColor: "var(--color-ember)", color: "var(--color-ember-soft)", padding: "0.4rem 0.9rem", fontSize: "0.85rem" }
                    : { padding: "0.4rem 0.9rem", fontSize: "0.85rem" }
                }
              >
                {g.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Operator badge + power-off key. */}
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            padding: 2,
            borderRadius: "50%",
            background: "var(--color-sunken)",
            boxShadow: "var(--shadow-inset)",
            flex: "0 0 auto",
          }}
        >
          <img
            src={me.user.avatarUrl}
            alt=""
            width={26}
            height={26}
            className="rounded-full"
            style={{ display: "block" }}
          />
        </span>
        <span className="font-mono text-xs hidden sm:inline" style={{ color: "var(--color-ink-dim)" }}>
          {me.user.username}
        </span>
        <button
          className="pill-ghost pill"
          style={{ padding: "0.4rem 0.85rem", fontSize: "0.8rem" }}
          onClick={onLogout}
        >
          Log out
        </button>
      </div>
    </header>
  );
}
