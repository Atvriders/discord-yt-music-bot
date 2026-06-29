// Per-guild playback settings. Driven by the live WS snapshot (the controller emits
// "changed" on every update) and persisted via POST /api/guilds/:id/settings, which
// the server clamps/validates. Mirrors the YouTube-themed styling of the rest of the
// panel.
import { useEffect, useState } from "react";
import type { AutoplaySource, RepeatMode } from "../types.js";

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
const CROSSFADE_MIN = 1;
const CROSSFADE_MAX = 12;
const CROSSFADE_DEFAULT = 4; // seconds applied when crossfade is toggled on

// Max-track-length presets (seconds). 0 = No limit (any length allowed). These let a
// user raise the cap so long content — e.g. a 3-hour concert — can play.
const MAX_LEN_PRESETS: { sec: number; label: string }[] = [
  { sec: 3600, label: "1 hour" },
  { sec: 7200, label: "2 hours" },
  { sec: 10800, label: "3 hours" },
  { sec: 14400, label: "4 hours" },
  { sec: 21600, label: "6 hours" },
  { sec: 0, label: "No limit" },
];

const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: "Off",
  one: "Repeat one",
  all: "Repeat all",
};

const AUTOPLAY_SOURCE_LABELS: Record<AutoplaySource, string> = {
  radio: "Radio / Mix",
  artist: "Artist",
};

export interface SettingsProps {
  idleTimeoutSec: number | undefined;
  crossfadeSec?: number;
  normalizeLoudness?: boolean;
  repeat?: RepeatMode;
  autoplay?: boolean;
  autoplaySource?: AutoplaySource;
  /** Per-guild max track length (seconds). 0 = No limit. */
  maxTrackDurationSec?: number;
  disabled?: boolean;
  onChange: (sec: number) => void;
  /** Persist a partial audio-settings patch (crossfade / normalize / repeat / autoplay). */
  onAudioChange?: (patch: {
    crossfadeSec?: number;
    normalizeLoudness?: boolean;
    repeat?: RepeatMode;
    autoplay?: boolean;
    autoplaySource?: AutoplaySource;
    maxTrackDurationSec?: number;
  }) => void;
}

export function Settings({
  idleTimeoutSec,
  crossfadeSec = 0,
  normalizeLoudness = false,
  repeat = "off",
  autoplay = false,
  autoplaySource = "radio",
  maxTrackDurationSec = 0,
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

  // Crossfade is modeled as a toggle + a duration. crossfadeSec === 0 means OFF; any
  // positive value means ON with that many seconds. While OFF we keep the last chosen
  // duration locally so flipping the toggle back on restores it (rather than snapping
  // to the default every time).
  // A persisted max-track-length that isn't one of the presets (e.g. seeded from a
  // custom MAX_TRACK_DURATION_SEC) would render the <select> blank; surface it as a
  // synthetic option so the current value is always visible and selected.
  const maxLenIsPreset = MAX_LEN_PRESETS.some((p) => p.sec === maxTrackDurationSec);

  const crossfadeOn = crossfadeSec > 0;
  const [lastCrossfadeSec, setLastCrossfadeSec] = useState(
    crossfadeOn ? crossfadeSec : CROSSFADE_DEFAULT,
  );
  // Keep the locally-remembered "restore" duration in sync with externally-driven prop
  // updates (e.g. a WS snapshot where another client turned crossfade on at 8s). Without
  // this, a later off→on toggle here would restore the stale default and overwrite their
  // value, because useState only seeds lastCrossfadeSec once at mount.
  useEffect(() => {
    if (crossfadeSec > 0) setLastCrossfadeSec(crossfadeSec);
  }, [crossfadeSec]);
  const sliderSec = crossfadeOn ? crossfadeSec : lastCrossfadeSec;
  const toggleCrossfade = (on: boolean) => audio({ crossfadeSec: on ? lastCrossfadeSec : 0 });
  const setCrossfadeSec = (sec: number) => {
    setLastCrossfadeSec(sec);
    audio({ crossfadeSec: sec });
  };

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

      <div
        className="flex items-center gap-3 text-xs"
        style={{ color: "var(--color-ink-dim)" }}
        title="Pseudo-crossfade: each track fades out at the end and in at the start. Tracks still play one at a time — Discord can't truly overlap two streams, so expect a brief dip to silence at the seam. Off = no fade."
      >
        <label className="flex items-center gap-2">
          <span className="eyebrow">Crossfade</span>
          <input
            type="checkbox"
            aria-label="Crossfade"
            checked={crossfadeOn}
            disabled={disabled}
            onChange={(e) => toggleCrossfade(e.target.checked)}
          />
        </label>
        {crossfadeOn && (
          <label className="flex items-center gap-2">
            <input
              type="range"
              min={CROSSFADE_MIN}
              max={CROSSFADE_MAX}
              step={1}
              aria-label="Crossfade seconds"
              value={sliderSec}
              disabled={disabled}
              onChange={(e) => setCrossfadeSec(Number(e.target.value))}
            />
            <span className="font-mono tabular-nums" style={{ minWidth: "2.5ch" }}>
              {sliderSec}s
            </span>
          </label>
        )}
      </div>

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

      <label
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--color-ink-dim)" }}
        title="Reject tracks longer than this when queuing. Raise it for long content (e.g. a 3-hour concert). No limit = any length allowed."
      >
        <span className="eyebrow">Max track length</span>
        <select
          aria-label="Max track length"
          value={String(maxTrackDurationSec)}
          disabled={disabled}
          onChange={(e) => audio({ maxTrackDurationSec: Number(e.target.value) })}
          className="bg-transparent rounded-lg px-3 py-2 text-sm"
          style={inputStyle}
        >
          {!maxLenIsPreset && (
            <option
              key={maxTrackDurationSec}
              value={String(maxTrackDurationSec)}
              style={{ background: "var(--color-raised)" }}
            >
              {maxTrackDurationSec}s (current)
            </option>
          )}
          {MAX_LEN_PRESETS.map((p) => (
            <option key={p.sec} value={String(p.sec)} style={{ background: "var(--color-raised)" }}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--color-ink-dim)" }}
        title="When the queue empties, keep playing tracks from YouTube's own Mix/radio for the last song. This is YouTube's related feed (keyed on the last track), not a precise genre classifier."
      >
        <span className="eyebrow">Autoplay</span>
        <input
          type="checkbox"
          aria-label="Autoplay"
          checked={autoplay}
          disabled={disabled}
          onChange={(e) => audio({ autoplay: e.target.checked })}
        />
      </label>

      {/* Source picker is only meaningful while autoplay is on. */}
      {autoplay && (
        <label
          className="flex items-center gap-2 text-xs"
          style={{ color: "var(--color-ink-dim)" }}
          title="Radio = YouTube's related/Mix feed for the last track. Artist = a YouTube search by the last track's channel/artist name (best-effort, not a verified discography)."
        >
          <span className="eyebrow">Autoplay source</span>
          <select
            aria-label="Autoplay source"
            value={autoplaySource}
            disabled={disabled}
            onChange={(e) => audio({ autoplaySource: e.target.value as AutoplaySource })}
            className="bg-transparent rounded-lg px-3 py-2 text-sm"
            style={inputStyle}
          >
            {(Object.keys(AUTOPLAY_SOURCE_LABELS) as AutoplaySource[]).map((s) => (
              <option key={s} value={s} style={{ background: "var(--color-raised)" }}>
                {AUTOPLAY_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* CROSSFADE HONESTY: be explicit that this is not a true overlap. */}
      <span className="text-xs basis-full" style={{ color: "var(--color-ink-faint)" }}>
        Crossfade is a pseudo-crossfade (fade out then fade in). Discord can&apos;t truly overlap
        two streams, so expect a brief dip to silence at the seam, not a real overlap. Normalize
        levels tracks to a consistent volume (EBU R128); both add some CPU cost.
      </span>

      {/* AUTOPLAY HONESTY: neither source is a genre classifier; artist is a name search. */}
      <span className="text-xs basis-full" style={{ color: "var(--color-ink-faint)" }}>
        Autoplay keeps the music going when the queue runs dry, keyed on the last song — not a
        precise genre classifier. Radio = YouTube&apos;s related/Mix feed for that track. Artist = a
        search by the track&apos;s channel/artist name, best-effort (only as accurate as that name
        and YouTube&apos;s search, not a verified discography).
      </span>
    </div>
  );
}
