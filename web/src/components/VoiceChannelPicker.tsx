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
    <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-dim)" }}>
      <span className="eyebrow">Channel</span>
      <select aria-label="Voice channel" value={value ?? ""} disabled={isEmpty} onChange={(e) => onChange(e.target.value)}
        className="bg-transparent rounded-lg px-3 py-2 text-sm"
        style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }}>
        <option value="" disabled>{placeholder}</option>
        {channels.map((c) => (<option key={c.id} value={c.id} style={{ background: "var(--color-raised)" }}>{c.name}</option>))}
      </select>
      {loadFailed && onRetry && (
        <button type="button" aria-label="Retry loading voice channels" onClick={onRetry}
          className="pill pill-ghost" style={{ padding: "0.2rem 0.55rem", fontSize: "0.75rem" }}>
          Retry
        </button>
      )}
    </label>
  );
}
