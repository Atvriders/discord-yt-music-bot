import { useState } from "react";
import type { PlaylistSummary } from "../types.js";

/**
 * Saved-playlists panel. Lets the user name and save the current+upcoming queue, then
 * load or delete any saved playlist. All persistence is server-side (per guild); this
 * component is purely presentational and delegates the mutations to the parent.
 *
 * The action callbacks are async so the parent can disable the relevant control while a
 * save/load/delete is in flight (preventing duplicate submits).
 */
export function Playlists({
  playlists,
  onSave,
  onLoad,
  onDelete,
  disabled = false,
}: {
  playlists: PlaylistSummary[];
  onSave: (name: string) => Promise<void> | void;
  onLoad: (name: string) => Promise<void> | void;
  onDelete: (name: string) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Per-row in-flight guard for Load/Delete so rapid clicks can't fire duplicate
  // in-flight API calls for the same playlist (a double Delete would 404 the second
  // request and desync the list). Keyed by playlist name; different rows stay
  // independently actionable.
  const [acting, setActing] = useState<Set<string>>(new Set());

  const trimmed = name.trim();
  const canSave = !disabled && !busy && trimmed.length > 0;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      await onSave(trimmed);
      setName("");
    } catch {
      // The parent surfaces error banners; swallow here so a rejected save doesn't become
      // an unhandled promise rejection. The typed name is intentionally left intact (NOT
      // cleared) so the user can retry, and the finally still re-enables the Save button.
    } finally {
      setBusy(false);
    }
  };

  const run = async (target: string, fn: (name: string) => Promise<void> | void) => {
    if (acting.has(target)) return; // already in flight for this row — ignore the dup
    setActing((s) => new Set(s).add(target));
    try {
      await fn(target);
    } catch {
      // The parent surfaces error banners; swallow here so a rejection doesn't become
      // an unhandled promise rejection. The finally still releases the row guard.
    } finally {
      setActing((s) => {
        const n = new Set(s);
        n.delete(target);
        return n;
      });
    }
  };

  return (
    <section className="card p-5 sm:p-6">
      {/* Faceplate header: engraved silkscreen label + a mono "saved" counter
          that reads like a channel count on the deck. */}
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Playlists</p>
        <span
          className="font-mono text-xs tabular-nums"
          style={{ color: "var(--color-ink-faint)" }}
        >
          {playlists.length} saved
        </span>
      </div>

      {/* Carved input well + a ghost "patch" key. The name is typed into a recess
          machined into the plate; the global input styling supplies the inset
          shadow + red focus ring. */}
      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled || busy}
          placeholder="Playlist name…"
          aria-label="Playlist name"
          maxLength={80}
          className="min-w-0 flex-1 px-3 py-2 text-sm"
          style={{
            border: "1px solid var(--color-line)",
            color: "var(--color-ink)",
          }}
        />
        <button
          type="submit"
          disabled={!canSave}
          className="pill pill-ghost shrink-0"
          style={{ padding: "0.5rem 0.95rem", fontSize: "0.8rem" }}
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          Save current
        </button>
      </form>

      {playlists.length === 0 ? (
        // Empty bank: a calm, machined "no patches loaded" notice.
        <p
          className="mt-4 text-sm"
          style={{ color: "var(--color-ink-faint)", fontFamily: "var(--font-mono)" }}
        >
          No saved playlists yet.
        </p>
      ) : (
        // Patch bank — reuses the Queue/Picker row pattern: a recessed slot per
        // saved playlist with a Fraunces title, mono track-count meta, and
        // hover-revealed ghost transport keys (Load / Delete).
        <ul className="mt-4 flex flex-col gap-1.5">
          {playlists.map((p) => (
            <li
              key={p.name}
              className="group flex items-center gap-3 px-3 py-2.5"
              style={{
                borderRadius: "var(--radius-sm)",
                border: "1px solid transparent",
                transition:
                  "background var(--dur-fast) var(--ease-mech), border-color var(--dur-fast) var(--ease-mech)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,0,0,0.04)";
                e.currentTarget.style.borderColor = "var(--color-line)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderColor = "transparent";
              }}
            >
              {/* Machined slot index marker — a faint red signal tick. */}
              <span
                aria-hidden="true"
                className="shrink-0 rounded-full"
                style={{
                  width: "7px",
                  height: "7px",
                  background:
                    "radial-gradient(circle at 35% 30%, var(--color-ember-soft), var(--color-ember) 70%, var(--color-ember-deep))",
                  boxShadow: "0 0 8px -1px rgba(255,0,0,0.55)",
                  opacity: 0.7,
                }}
              />
              <div className="min-w-0 flex-1">
                <p
                  className="font-display truncate text-sm"
                  style={{ color: "var(--color-ink)" }}
                  title={p.name}
                >
                  {p.name}
                </p>
                <p
                  className="font-mono truncate text-xs tabular-nums"
                  style={{ color: "var(--color-ink-faint)" }}
                >
                  {p.trackCount} track{p.trackCount === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  aria-label={`Load ${p.name}`}
                  disabled={disabled || acting.has(p.name)}
                  onClick={() => void run(p.name, onLoad)}
                  className="pill pill-ghost"
                  style={{ padding: "0.3rem 0.75rem", fontSize: "0.75rem" }}
                >
                  Load
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${p.name}`}
                  disabled={disabled || acting.has(p.name)}
                  onClick={() => void run(p.name, onDelete)}
                  className="pill pill-ghost"
                  style={{ padding: "0.3rem 0.75rem", fontSize: "0.75rem" }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
