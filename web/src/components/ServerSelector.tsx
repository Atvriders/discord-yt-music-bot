import type { Me } from "../types.js";

export function ServerSelector({ me, activeGuildId, onSelect, onLogout }: {
  me: Me; activeGuildId: string | null; onSelect: (id: string) => void; onLogout: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-3 justify-between reveal">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-display text-xl" style={{ color: "var(--color-ember-soft)" }}>▶ YouTube Music Bot</span>
        <div className="flex flex-wrap gap-1.5">
          {me.guilds.length === 0 && <span className="text-xs" style={{ color: "var(--color-ink-faint)" }}>No shared servers.</span>}
          {me.guilds.map((g) => (
            <button key={g.id} onClick={() => onSelect(g.id)}
              className="pill" aria-pressed={g.id === activeGuildId}
              style={g.id === activeGuildId ? { borderColor: "rgba(255,138,61,0.6)", color: "var(--color-ember-soft)" } : undefined}>
              {g.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2.5">
        <img src={me.user.avatarUrl} alt="" width={26} height={26} className="rounded-full" />
        <span className="text-xs" style={{ color: "var(--color-ink-dim)" }}>{me.user.username}</span>
        <button className="pill" style={{ padding: "0.4rem 0.8rem", fontSize: "0.8rem" }} onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}
