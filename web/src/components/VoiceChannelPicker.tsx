import type { VoiceChannel } from "../types.js";

export function VoiceChannelPicker({ channels, value, onChange }: {
  channels: VoiceChannel[]; value: string | null; onChange: (id: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-dim)" }}>
      <span className="eyebrow">Channel</span>
      <select aria-label="Voice channel" value={value ?? ""} onChange={(e) => onChange(e.target.value)}
        className="bg-transparent rounded-lg px-3 py-2 text-sm"
        style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }}>
        <option value="" disabled>pick a channel…</option>
        {channels.map((c) => (<option key={c.id} value={c.id} style={{ background: "var(--color-raised)" }}>{c.name}</option>))}
      </select>
    </label>
  );
}
