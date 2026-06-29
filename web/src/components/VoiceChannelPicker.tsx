import type { VoiceChannel } from "../types.js";

export function VoiceChannelPicker({ channels, value, loadFailed, onChange, onRetry }: {
  channels: VoiceChannel[];
  value: string | null;
  /** True when the voice-channels fetch failed (vs. legitimately empty). */
  loadFailed?: boolean;
  onChange: (id: string) => void;
  /** Re-run the voice-channels fetch (shown as a retry affordance on failure). */
  onRetry?: () => void;
}) {
  // Always render the control so the user has an affordance even when there are no
  // channels — otherwise "Pick a voice channel first" tells them to use a control that
  // isn't on screen. Distinguish a load failure (recoverable, offer retry) from a
  // genuinely empty server.
  const isEmpty = channels.length === 0;
  const placeholder = loadFailed
    ? "couldn't load — retry"
    : isEmpty
      ? "no voice channels"
      : "pick a channel…";
  return (
    // A small machined "patch bay" strip on the faceplate: engraved label over a
    // carved select well, with a hot-red Retry key when the signal drops.
    <label className="inline-flex items-center gap-3">
      <span className="eyebrow" style={{ color: "var(--color-ink-faint)" }}>
        Channel
      </span>
      <select
        aria-label="Voice channel"
        value={value ?? ""}
        disabled={isEmpty}
        onChange={(e) => onChange(e.target.value)}
        // Carved recessed well (fill + inset shadow + tinted caret come from
        // index.css); we keep border + ink inline so the focus ring overrides cleanly.
        className="px-3 py-2 text-sm"
        style={{
          border: "1px solid var(--color-line)",
          color: "var(--color-ink)",
          fontFamily: "var(--font-sans)",
          fontWeight: 500,
          minWidth: "11rem",
        }}
      >
        <option value="" disabled style={{ color: "var(--color-ink-faint)" }}>
          {placeholder}
        </option>
        {channels.map((c) => (
          <option
            key={c.id}
            value={c.id}
            style={{ background: "var(--color-raised)", color: "var(--color-ink)" }}
          >
            {c.name}
          </option>
        ))}
      </select>
      {loadFailed && onRetry && (
        <button
          type="button"
          aria-label="Retry loading voice channels"
          onClick={onRetry}
          // Flat utility key that flushes red on hover (the console "re-arm signal").
          className="pill pill-ghost font-mono"
          style={{ padding: "0.25rem 0.7rem", fontSize: "0.72rem", letterSpacing: "0.04em" }}
        >
          Retry
        </button>
      )}
    </label>
  );
}
