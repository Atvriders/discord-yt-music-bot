// Per-guild playback settings. Driven by the live WS snapshot (the controller emits
// "changed" on every update) and persisted via POST /api/guilds/:id/settings, which
// the server clamps/validates. Styled as a Late-Night Studio console "settings strip":
// a machined faceplate of engraved labels, carved-in selects, VU faders and toggle lamps.
import { useEffect, useState } from "react";
import type { AutoplaySource, FxPreset, RepeatMode, TextChannel } from "../types.js";

// Idle-timeout presets in seconds. The backend has no "stay forever" sentinel on this
// select's path (it always arms setTimeout(idleTimeoutMs)), so 3600 really means a 1-hour
// idle cutoff — label it honestly as "1 hour" rather than promising a "Never" the bot can't
// actually honor (it would still disconnect after exactly an hour of idle).
const PRESETS: { sec: number; label: string }[] = [
  { sec: 60, label: "1 minute" },
  { sec: 300, label: "5 minutes" },
  { sec: 600, label: "10 minutes" },
  { sec: 900, label: "15 minutes" },
  { sec: 1800, label: "30 minutes" },
  { sec: 3600, label: "1 hour" },
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

const VOLUME_MAX = 200;

const FX_LABELS: Record<FxPreset, string> = {
  none: "None",
  bassboost: "Bass boost",
  nightcore: "Nightcore",
  vaporwave: "Vaporwave",
  eightd: "8D",
  treble: "Treble",
  karaoke: "Karaoke",
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
  /** Playback volume percentage (0–200, 100 = unchanged). */
  volume?: number;
  /** Audio FX preset. */
  fx?: FxPreset;
  /** The single text channel the bot is restricted to, or null = any channel (default). */
  commandChannelId?: string | null;
  /** The guild's text channels (for the command-channel picker). */
  textChannels?: TextChannel[];
  disabled?: boolean;
  onChange: (sec: number) => void;
  /** Persist a partial audio-settings patch (crossfade / normalize / repeat / autoplay / volume / fx / command channel). */
  onAudioChange?: (patch: {
    crossfadeSec?: number;
    normalizeLoudness?: boolean;
    repeat?: RepeatMode;
    autoplay?: boolean;
    autoplaySource?: AutoplaySource;
    maxTrackDurationSec?: number;
    volume?: number;
    fx?: FxPreset;
    commandChannelId?: string | null;
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
  volume = 100,
  fx = "none",
  commandChannelId = null,
  textChannels = [],
  disabled,
  onChange,
  onAudioChange,
}: SettingsProps) {
  const value = idleTimeoutSec ?? DEFAULT_SEC;
  // A persisted value that isn't one of the presets (e.g. 120s set via the bot/API)
  // would otherwise render the <select> blank. Surface it as a synthetic option so
  // the current value is always visible and selected.
  const isPreset = PRESETS.some((p) => p.sec === value);
  // Carved-in well: the recessed-field look comes from index.css (sunken fill + inset
  // shadow + red focus ring). We only seed the hairline border + cream ink here.
  const inputStyle = { border: "1px solid var(--color-line)", color: "var(--color-ink)" } as const;
  // Radius is supplied by the global `select` rule (var(--radius-sm)); don't pin a
  // Tailwind radius here or it overrides the carved-well token.
  const selectClass = "bg-transparent px-3 py-2 text-sm font-mono tracking-tight";
  // The amber option background for the open native menu.
  const optStyle = { background: "var(--color-raised)", color: "var(--color-ink)" } as const;
  const audio = (patch: Parameters<NonNullable<typeof onAudioChange>>[0]) => onAudioChange?.(patch);

  // Crossfade is modeled as a toggle + a duration. crossfadeSec === 0 means OFF; any
  // positive value means ON with that many seconds. While OFF we keep the last chosen
  // duration locally so flipping the toggle back on restores it (rather than snapping
  // to the default every time).
  // A persisted max-track-length that isn't one of the presets (e.g. seeded from a
  // custom MAX_TRACK_DURATION_SEC) would render the <select> blank; surface it as a
  // synthetic option so the current value is always visible and selected.
  const maxLenIsPreset = MAX_LEN_PRESETS.some((p) => p.sec === maxTrackDurationSec);

  // A configured command channel that isn't in the fetched text-channel list (e.g. set via
  // the bot's `?channel`, or a channel the panel couldn't enumerate) would render the
  // <select> blank; surface it as a synthetic option so the current value stays visible.
  const commandChannelMissing =
    commandChannelId != null && !textChannels.some((c) => c.id === commandChannelId);

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
    // Settings flows inline within App's transport-strip card, so this is a faceplate
    // sub-module (not its own .card): engraved labels, carved-in wells, VU faders and
    // toggle lamps. The honesty captions break to a full row beneath the control bank.
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3" aria-label="Playback settings">
      {/* The bank of carved controls. Each field is a labelled module on the deck. */}
      <label className="flex flex-col gap-1.5">
          <span className="eyebrow">Leave channel after tracks end</span>
          <select
            aria-label="Leave channel after tracks end"
            value={String(value)}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
            className={selectClass}
            style={inputStyle}
          >
            {!isPreset && (
              <option key={value} value={String(value)} style={optStyle}>
                {value}s (current)
              </option>
            )}
            {PRESETS.map((p) => (
              <option key={p.sec} value={String(p.sec)} style={optStyle}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">Repeat</span>
          <select
            aria-label="Repeat mode"
            value={repeat}
            disabled={disabled}
            onChange={(e) => audio({ repeat: e.target.value as RepeatMode })}
            className={selectClass}
            style={inputStyle}
          >
            {(Object.keys(REPEAT_LABELS) as RepeatMode[]).map((m) => (
              <option key={m} value={m} style={optStyle}>
                {REPEAT_LABELS[m]}
              </option>
            ))}
          </select>
        </label>

        {/* Volume — the master VU fader. The % readout is a mono counter on the deck. */}
        <label
          className="flex flex-col gap-1.5"
          title="Playback volume. 100% = unchanged. Anything other than 100% uses the transcode path (no Opus passthrough) because inline volume needs PCM."
        >
          <span className="eyebrow">Volume</span>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={VOLUME_MAX}
              step={5}
              aria-label="Volume"
              value={volume}
              disabled={disabled}
              onChange={(e) => audio({ volume: Number(e.target.value) })}
              // WebKit fill-to-left-of-thumb: feed the value % to the track gradient.
              style={{ "--range-fill": `${(volume / VOLUME_MAX) * 100}%` } as React.CSSProperties}
            />
            <span
              className="font-mono tabular-nums text-sm"
              style={{ minWidth: "4ch", color: "var(--color-ink)", textAlign: "right" }}
            >
              {volume}%
            </span>
          </div>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">FX preset</span>
          <select
            aria-label="FX preset"
            value={fx}
            disabled={disabled}
            onChange={(e) => audio({ fx: e.target.value as FxPreset })}
            className={selectClass}
            style={inputStyle}
          >
            {(Object.keys(FX_LABELS) as FxPreset[]).map((f) => (
              <option key={f} value={f} style={optStyle}>
                {FX_LABELS[f]}
              </option>
            ))}
          </select>
        </label>

        {/* Crossfade — a toggle lamp plus, when lit, its own VU fader. */}
        <div
          className="flex flex-col gap-1.5"
          title="Pseudo-crossfade: each track fades out at the end and in at the start. Tracks still play one at a time — Discord can't truly overlap two streams, so expect a brief dip to silence at the seam. Off = no fade."
        >
          <span className="eyebrow">Crossfade</span>
          <div className="flex items-center gap-4">
            <label
              className="flex items-center gap-2 text-sm"
              style={{ color: "var(--color-ink-dim)" }}
            >
              <input
                type="checkbox"
                aria-label="Crossfade"
                checked={crossfadeOn}
                disabled={disabled}
                onChange={(e) => toggleCrossfade(e.target.checked)}
              />
              <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                {crossfadeOn ? "ON" : "OFF"}
              </span>
            </label>
            {crossfadeOn && (
              <label className="flex items-center gap-3">
                <input
                  type="range"
                  min={CROSSFADE_MIN}
                  max={CROSSFADE_MAX}
                  step={1}
                  aria-label="Crossfade seconds"
                  value={sliderSec}
                  disabled={disabled}
                  onChange={(e) => setCrossfadeSec(Number(e.target.value))}
                  // WebKit fill-to-left-of-thumb: feed the value % to the track gradient.
                  style={
                    {
                      "--range-fill": `${
                        ((sliderSec - CROSSFADE_MIN) / (CROSSFADE_MAX - CROSSFADE_MIN)) * 100
                      }%`,
                    } as React.CSSProperties
                  }
                />
                <span
                  className="font-mono tabular-nums text-sm"
                  style={{ minWidth: "2.5ch", color: "var(--color-ink)", textAlign: "right" }}
                >
                  {sliderSec}s
                </span>
              </label>
            )}
          </div>
        </div>

        {/* Normalize — toggle lamp. */}
        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">Normalize loudness</span>
          <span
            className="flex items-center gap-2 text-sm"
            style={{ color: "var(--color-ink-dim)" }}
          >
            <input
              type="checkbox"
              aria-label="Normalize loudness"
              checked={normalizeLoudness}
              disabled={disabled}
              onChange={(e) => audio({ normalizeLoudness: e.target.checked })}
            />
            <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
              EBU&nbsp;R128
            </span>
          </span>
        </label>

        <label
          className="flex flex-col gap-1.5"
          title="Reject tracks longer than this when queuing. Raise it for long content (e.g. a 3-hour concert). No limit = any length allowed."
        >
          <span className="eyebrow">Max track length</span>
          <select
            aria-label="Max track length"
            value={String(maxTrackDurationSec)}
            disabled={disabled}
            onChange={(e) => audio({ maxTrackDurationSec: Number(e.target.value) })}
            className={selectClass}
            style={inputStyle}
          >
            {!maxLenIsPreset && (
              <option key={maxTrackDurationSec} value={String(maxTrackDurationSec)} style={optStyle}>
                {maxTrackDurationSec}s (current)
              </option>
            )}
            {MAX_LEN_PRESETS.map((p) => (
              <option key={p.sec} value={String(p.sec)} style={optStyle}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {/* Command channel — restrict the bot to a single text channel. Any = unrestricted. */}
        <label
          className="flex flex-col gap-1.5"
          title="Restrict the bot to ONE text channel: it only accepts ? commands there and posts its now-playing card / replies there. Any channel = unrestricted (the default). You can also set this from Discord with ?channel."
        >
          <span className="eyebrow">Command channel</span>
          <select
            aria-label="Command channel"
            value={commandChannelId ?? ""}
            disabled={disabled}
            onChange={(e) =>
              audio({ commandChannelId: e.target.value === "" ? null : e.target.value })
            }
            className={selectClass}
            style={inputStyle}
          >
            <option value="" style={optStyle}>
              Any channel
            </option>
            {commandChannelMissing && (
              <option value={commandChannelId!} style={optStyle}>
                {commandChannelId} (current)
              </option>
            )}
            {textChannels.map((c) => (
              <option key={c.id} value={c.id} style={optStyle}>
                #{c.name}
              </option>
            ))}
          </select>
        </label>

        {/* Autoplay — toggle lamp; the source picker lights up only when engaged. */}
        <div
          className="flex flex-col gap-1.5"
          title="When the queue empties, keep playing tracks from YouTube's own Mix/radio for the last song. This is YouTube's related feed (keyed on the last track), not a precise genre classifier."
        >
          <span className="eyebrow">Autoplay</span>
          <div className="flex items-center gap-4">
            <label
              className="flex items-center gap-2 text-sm"
              style={{ color: "var(--color-ink-dim)" }}
            >
              <input
                type="checkbox"
                aria-label="Autoplay"
                checked={autoplay}
                disabled={disabled}
                onChange={(e) => audio({ autoplay: e.target.checked })}
              />
              <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                {autoplay ? "ON" : "OFF"}
              </span>
            </label>

            {/* Source picker is only meaningful while autoplay is on. */}
            {autoplay && (
              <label
                className="flex items-center gap-2"
                title="Radio = YouTube's related/Mix feed for the last track. Artist = a YouTube search by the last track's channel/artist name (best-effort, not a verified discography)."
              >
                <span className="eyebrow">Source</span>
                <select
                  aria-label="Autoplay source"
                  value={autoplaySource}
                  disabled={disabled}
                  onChange={(e) => audio({ autoplaySource: e.target.value as AutoplaySource })}
                  className={selectClass}
                  style={inputStyle}
                >
                  {(Object.keys(AUTOPLAY_SOURCE_LABELS) as AutoplaySource[]).map((s) => (
                    <option key={s} value={s} style={optStyle}>
                      {AUTOPLAY_SOURCE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {/* Honesty captions — engraved silkscreen footnotes break to their own deck row. */}
        <div
          className="basis-full space-y-2 border-t pt-3 mt-1"
          style={{ borderColor: "var(--color-line)" }}
        >
          {/* CROSSFADE HONESTY: be explicit that this is not a true overlap. */}
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-ink-faint)" }}>
            Crossfade is a pseudo-crossfade (fade out then fade in). Discord can&apos;t truly overlap
            two streams, so expect a brief dip to silence at the seam, not a real overlap. Normalize
            levels tracks to a consistent volume (EBU R128); both add some CPU cost.
          </p>

          {/* AUTOPLAY HONESTY: neither source is a genre classifier; artist is a name search. */}
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-ink-faint)" }}>
            Autoplay keeps the music going when the queue runs dry, keyed on the last song — not a
            precise genre classifier. Radio = YouTube&apos;s related/Mix feed for that track. Artist = a
            search by the track&apos;s channel/artist name, best-effort (only as accurate as that name
            and YouTube&apos;s search, not a verified discography).
          </p>
        </div>
    </div>
  );
}
