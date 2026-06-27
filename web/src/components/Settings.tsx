// Per-guild playback settings. Driven by the live WS snapshot (the controller emits
// "changed" on every update) and persisted via POST /api/guilds/:id/settings, which
// the server clamps/validates. Mirrors the YouTube-themed styling of the rest of the
// panel.
import type { RepeatMode } from "../types.js";

// Idle-timeout presets in seconds. The max (3600 = 1h) is surfaced as a "Never" option
// so the bot effectively stays until it is removed.
const PRESETS: { sec: number; label: string }[] = [
  { sec: 60, label: "1 minute" },
  { sec: 300, label: "5 minutes" },
  { sec: 600, label: "10 minutes" },
  { sec: 900, label: "15 minutes" },
  { sec: 1800, label: "30 minutes" },
  { sec: 3600, label: "Never (stay until removed)" },
];

const DEFAULT_SEC = 300; // 5 minutes
const CROSSFADE_MAX = 12;

const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: "Off",
  one: "Repeat one",
  all: "Repeat all",
};

export interface SettingsProps {
  idleTimeoutSec: number | undefined;
  crossfadeSec?: number;
  normalizeLoudness?: boolean;
  repeat?: RepeatMode;
  disabled?: boolean;
  onChange: (sec: number) => void;
  /** Persist a partial audio-settings patch (crossfade / normalize / repeat). */
  onAudioChange?: (patch: {
    crossfadeSec?: number;
    normalizeLoudness?: boolean;
    repeat?: RepeatMode;
  }) => void;
}

export function Settings({
  idleTimeoutSec,
  crossfadeSec = 0,
  normalizeLoudness = false,
  repeat = "off",
  disabled,
  onChange,
  onAudioChange,
}: SettingsProps) {
  const value = idleTimeoutSec ?? DEFAULT_SEC;
  // A persisted value that isn't one of the presets (e.g. 120s set via the bot/API)
  // would otherwise render the <select> blank. Surface it as a synthetic option so
  // the current value is always visible and selected.
  const isPreset = PRESETS.some((p) => p.sec === value);
  const inputStyle = { border: "1px solid var(--color-line)", color: "var(--color-ink)" } as const;
  const audio = (patch: Parameters<NonNullable<typeof onAudioChange>>[0]) => onAudioChange?.(patch);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <label
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--color-ink-dim)" }}
      >
        <span className="eyebrow">Leave channel after tracks end</span>
        <select
          aria-label="Leave channel after tracks end"
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="bg-transparent rounded-lg px-3 py-2 text-sm"
          style={inputStyle}
        >
          {!isPreset && (
            <option key={value} value={String(value)} style={{ background: "var(--color-raised)" }}>
              {value}s (current)
            </option>
          )}
          {PRESETS.map((p) => (
            <option key={p.sec} value={String(p.sec)} style={{ background: "var(--color-raised)" }}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-dim)" }}>
        <span className="eyebrow">Repeat</span>
        <select
          aria-label="Repeat mode"
          value={repeat}
          disabled={disabled}
          onChange={(e) => audio({ repeat: e.target.value as RepeatMode })}
          className="bg-transparent rounded-lg px-3 py-2 text-sm"
          style={inputStyle}
        >
          {(Object.keys(REPEAT_LABELS) as RepeatMode[]).map((m) => (
            <option key={m} value={m} style={{ background: "var(--color-raised)" }}>
              {REPEAT_LABELS[m]}
            </option>
          ))}
        </select>
      </label>

      <label
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--color-ink-dim)" }}
        title="Pseudo-crossfade: each track fades out at the end and in at the start. Tracks still play one at a time — Discord can't truly overlap two streams, so expect a brief dip to silence at the seam. 0 = off."
      >
        <span className="eyebrow">Crossfade (sec)</span>
        <input
          type="number"
          min={0}
          max={CROSSFADE_MAX}
          step={1}
          aria-label="Crossfade seconds"
          value={crossfadeSec}
          disabled={disabled}
          onChange={(e) => audio({ crossfadeSec: Number(e.target.value) })}
          className="bg-transparent rounded-lg px-3 py-2 text-sm w-16"
          style={inputStyle}
        />
      </label>

      <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-dim)" }}>
        <span className="eyebrow">Normalize loudness</span>
        <input
          type="checkbox"
          aria-label="Normalize loudness"
          checked={normalizeLoudness}
          disabled={disabled}
          onChange={(e) => audio({ normalizeLoudness: e.target.checked })}
        />
      </label>

      {/* CROSSFADE HONESTY: be explicit that this is not a true overlap. */}
      <span className="text-xs basis-full" style={{ color: "var(--color-ink-faint)" }}>
        Crossfade is a pseudo-crossfade (fade out then fade in). Discord can&apos;t truly overlap
        two streams, so expect a brief dip to silence at the seam, not a real overlap. Normalize
        levels tracks to a consistent volume (EBU R128); both add some CPU cost.
      </span>
    </div>
  );
}
