import { useState } from "react";
import type { TrackMeta } from "../types.js";
import { Picker } from "./Picker.js";

export function AddBar({ onPlay, onQueueAll, busy }: {
  onPlay: (input: string) => Promise<{ candidates: TrackMeta[] | null }>; // returns candidates for a search, else null
  /** Queues all selected candidates IN ORDER; resolves to whether ≥1 was queued. */
  onQueueAll: (videoIds: string[]) => Promise<boolean>; busy?: boolean;
}) {
  const [input, setInput] = useState("");
  const [candidates, setCandidates] = useState<TrackMeta[] | null>(null);
  // ITEM 5: resolving a link (yt-dlp) takes several seconds. Clear the box and show
  // a pending state IMMEDIATELY on submit so the UI feels instant, then await in bg.
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = input.trim();
    if (!value || pending) return;
    setInput(""); // instant: empty the box before the (slow) resolve
    setCandidates(null);
    setPending(true);
    try {
      const { candidates: c } = await onPlay(value);
      setCandidates(c);
    } finally {
      setPending(false);
    }
  }
  const disabled = busy || pending;
  return (
    <section className="card reveal p-5 sm:p-6" style={{ animationDelay: "120ms" }}>
      <form onSubmit={submit} className="flex gap-2.5">
        <input value={input} onChange={(e) => setInput(e.target.value)} disabled={disabled}
          placeholder="Paste a YouTube link, or search a song…" aria-label="Add a track"
          className="flex-1 bg-transparent outline-none text-sm px-4 py-3 rounded-xl"
          style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }} />
        <button className="pill pill-primary" disabled={disabled} type="submit">
          {pending ? (<><span className="spinner" aria-hidden /> Resolving…</>) : "Queue it"}
        </button>
      </form>
      {candidates && candidates.length === 0 && (
        <p className="mt-4 text-sm" style={{ color: "var(--color-ink-faint)" }}>
          No matches — try a different search.
        </p>
      )}
      {candidates && candidates.length > 0 && (
        <div className="mt-4">
          <Picker
            candidates={candidates}
            busy={busy}
            // Queue every selected candidate IN ORDER via one batched, ordered request.
            onQueueSelected={onQueueAll}
            onQueued={() => { setCandidates(null); setInput(""); }}
          />
        </div>
      )}
    </section>
  );
}
