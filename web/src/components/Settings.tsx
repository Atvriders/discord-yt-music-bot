// Per-guild idle-timeout control: how long the bot lingers in the voice channel
// after playback ends. Mirrors the YouTube-themed styling of VoiceChannelPicker.

// Presets in seconds. The max (3600 = 1h) is surfaced as a "Never" option so the
// bot effectively stays until it is removed.
const PRESETS: { sec: number; label: string }[] = [
  { sec: 60, label: "1 minute" },
  { sec: 300, label: "5 minutes" },
  { sec: 600, label: "10 minutes" },
  { sec: 900, label: "15 minutes" },
  { sec: 1800, label: "30 minutes" },
  { sec: 3600, label: "Never (stay until removed)" },
];

const DEFAULT_SEC = 300; // 5 minutes

export function Settings({
  idleTimeoutSec,
  disabled,
  onChange,
}: {
  idleTimeoutSec: number | undefined;
  disabled?: boolean;
  onChange: (sec: number) => void;
}) {
  const value = idleTimeoutSec ?? DEFAULT_SEC;
  return (
    <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-dim)" }}>
      <span className="eyebrow">Leave channel after tracks end</span>
      <select
        aria-label="Leave channel after tracks end"
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="bg-transparent rounded-lg px-3 py-2 text-sm"
        style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }}
      >
        {PRESETS.map((p) => (
          <option key={p.sec} value={String(p.sec)} style={{ background: "var(--color-raised)" }}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
