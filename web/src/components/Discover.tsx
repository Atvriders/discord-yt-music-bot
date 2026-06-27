import { useState } from "react";
import type { TrackMeta } from "../types.js";
import { fmtTime } from "../lib/format.js";

// NOTE: This is a preset/search-based browser, NOT a recommendation engine.
// Each preset maps to a plain YouTube search query (the same flow as the AddBar
// search). Clicking a preset runs that search and shows the existing picker so
// the user queues an exact track — nothing is pulled from a personalized or
// recommendation source.

export interface DiscoverPreset {
  /** Stable id, also used as the visible label. */
  label: string;
  /** The search query handed to the existing play/search flow. */
  query: string;
}

export const GENRE_PRESETS: DiscoverPreset[] = [
  { label: "Lofi", query: "lofi hip hop beats to study" },
  { label: "Rock", query: "classic rock essentials" },
  { label: "Hip-Hop", query: "hip hop hits playlist" },
  { label: "Electronic", query: "electronic dance music mix" },
  { label: "Jazz", query: "smooth jazz instrumental" },
  { label: "Classical", query: "classical music masterpieces" },
  { label: "Pop", query: "pop hits this year" },
  { label: "Metal", query: "metal anthems" },
];

export const MOOD_PRESETS: DiscoverPreset[] = [
  { label: "Chill", query: "chill relaxing music mix" },
  { label: "Focus", query: "focus deep concentration music" },
  { label: "Workout", query: "workout gym motivation music" },
  { label: "Party", query: "party dance hits mix" },
  { label: "Sleep", query: "calm sleep music ambient" },
  { label: "Happy", query: "happy feel good songs" },
];

function PresetRow({
  eyebrow,
  presets,
  activeQuery,
  busy,
  onPick,
}: {
  eyebrow: string;
  presets: DiscoverPreset[];
  activeQuery: string | null;
  busy: boolean;
  onPick: (p: DiscoverPreset) => void;
}) {
  return (
    <div>
      <p className="eyebrow px-1 pb-2">{eyebrow}</p>
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => {
          const active = activeQuery === p.query;
          return (
            <button
              key={p.label}
              type="button"
              disabled={busy}
              aria-pressed={active}
              onClick={() => onPick(p)}
              className={active ? "pill pill-primary" : "pill"}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Discover({
  onSearch,
  onPick,
  busy,
}: {
  /** Runs a search via the existing play flow; returns search candidates (or null if it didn't search). */
  onSearch: (query: string) => Promise<{ candidates: TrackMeta[] | null }>;
  /** Queues the chosen exact track. */
  onPick: (videoId: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TrackMeta[] | null>(null);

  async function run(p: DiscoverPreset) {
    setActiveQuery(p.query);
    setLoading(true);
    setCandidates(null);
    try {
      const { candidates: c } = await onSearch(p.query);
      setCandidates(c);
    } finally {
      setLoading(false);
    }
  }

  const disabled = !!busy || loading;

  return (
    <section className="card reveal p-5 sm:p-6" style={{ animationDelay: "150ms" }}>
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">Discover</p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="pill pill-ghost"
          style={{ padding: "0.3rem 0.7rem", fontSize: "0.8rem" }}
        >
          {open ? "Hide" : "Browse"}
        </button>
      </div>

      {open && (
        <div className="mt-4 flex flex-col gap-5">
          <p className="text-xs" style={{ color: "var(--color-ink-faint)" }}>
            Preset searches by genre and mood — pick one to search YouTube, then queue the exact track. Not a
            recommendation engine.
          </p>
          <PresetRow eyebrow="By genre" presets={GENRE_PRESETS} activeQuery={activeQuery} busy={disabled} onPick={run} />
          <PresetRow eyebrow="By mood" presets={MOOD_PRESETS} activeQuery={activeQuery} busy={disabled} onPick={run} />

          {loading && (
            <p className="text-sm" style={{ color: "var(--color-ink-faint)" }}>
              Searching…
            </p>
          )}

          {!loading && candidates && candidates.length === 0 && (
            <p className="text-sm" style={{ color: "var(--color-ink-faint)" }}>
              No tracks found for that preset.
            </p>
          )}

          {!loading && candidates && candidates.length > 0 && (
            <ul className="flex flex-col gap-1">
              <li className="eyebrow px-1 pb-1">Pick the exact track</li>
              {candidates.map((c) => (
                <li key={c.videoId}>
                  <button
                    onClick={() => {
                      onPick(c.videoId);
                      setCandidates(null);
                      setActiveQuery(null);
                    }}
                    className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left"
                    style={{ transition: "background .15s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <img
                      src={c.thumbnailUrl ?? ""}
                      alt=""
                      width={44}
                      height={44}
                      className="rounded-md object-cover"
                      style={{ width: 44, height: 44 }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{c.title}</span>
                      <span className="block truncate text-xs" style={{ color: "var(--color-ink-faint)" }}>
                        {c.channel} · <span className="font-mono">{fmtTime(c.durationSec)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
