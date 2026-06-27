import { useCallback, useEffect, useRef, useState } from "react";
import type { Me, TrackMeta, VoiceChannel } from "../types.js";
import { api, ApiError, type ControlAction } from "../lib/api.js";
import { useGuildState } from "../lib/useGuildState.js";
import { Grain } from "./Grain.js";
import { LoginGate } from "./LoginGate.js";
import { ServerSelector } from "./ServerSelector.js";
import { NowPlaying } from "./NowPlaying.js";
import { Controls } from "./Controls.js";
import { Queue } from "./Queue.js";
import { AddBar } from "./AddBar.js";
import { VoiceChannelPicker } from "./VoiceChannelPicker.js";

type BannerMsg = { kind: "success"; text: string } | { kind: "error"; text: string };

function StatusBanner({ msg, onDismiss }: { msg: BannerMsg; onDismiss: () => void }) {
  const isError = msg.kind === "error";
  return (
    <div
      className="card reveal flex items-center gap-3 px-4 py-3 text-sm"
      style={{
        borderColor: isError ? "var(--color-danger, #e05252)" : "var(--color-line)",
        color: isError ? "var(--color-danger, #e05252)" : "var(--color-ink)",
      }}
    >
      <span className="flex-1 min-w-0 truncate">{msg.text}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{ color: "var(--color-ink-faint)", fontSize: "1rem", lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [voiceChannelId, setVoiceChannelId] = useState<string | null>(null);
  const live = useGuildState(guildId);

  // Status banner state: current message + which lastError.seq we've already shown.
  const [banner, setBanner] = useState<BannerMsg | null>(null);
  const shownSeqRef = useRef<number>(0);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showBanner = useCallback((msg: BannerMsg) => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    setBanner(msg);
    autoDismissRef.current = setTimeout(() => setBanner(null), 6000);
  }, []);

  const dismissBanner = useCallback(() => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    setBanner(null);
  }, []);

  // Sync play-time errors from the WS stream.
  useEffect(() => {
    const e = live.lastError;
    if (!e) return;
    if (e.seq <= shownSeqRef.current) return;
    shownSeqRef.current = e.seq;
    showBanner({ kind: "error", text: `Couldn't play ${e.title} — ${e.reason}` });
  }, [live.lastError, showBanner]);

  // Clear banner on guild switch.
  useEffect(() => { setBanner(null); shownSeqRef.current = 0; }, [guildId]);

  useEffect(() => setPaused(false), [guildId]);

  useEffect(() => {
    if (!guildId) { setChannels([]); setVoiceChannelId(null); return; }
    api.voiceChannels(guildId).then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, [guildId]);

  useEffect(() => {
    api.me().then((m) => { setMe(m); setGuildId((g) => g ?? m.guilds[0]?.id ?? null); })
      .catch(() => setMe(null)).finally(() => setAuthChecked(true));
  }, []);

  const control = useCallback(async (a: ControlAction) => {
    if (!guildId) return;
    if (a === "pause") setPaused(true);
    if (a === "resume") setPaused(false);
    await api.control(guildId, a).catch(() => {});
  }, [guildId]);

  const onPlay = useCallback(async (input: string): Promise<{ candidates: TrackMeta[] | null; queuedTitle?: string }> => {
    if (!guildId) return { candidates: null };
    try {
      const r = await api.play(guildId, input, voiceChannelId ?? undefined);
      if (r.queued) {
        showBanner({ kind: "success", text: `Queued: ${r.queued.title}` });
      }
      return { candidates: r.candidates ?? null };
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: msg });
      return { candidates: null };
    }
  }, [guildId, voiceChannelId, showBanner]);

  const onPick = useCallback((videoId: string) => {
    if (!guildId) return;
    api.pick(guildId, videoId, voiceChannelId ?? undefined)
      .then((r) => { if (r.queued) showBanner({ kind: "success", text: `Queued: ${r.queued.title}` }); })
      .catch((err: unknown) => {
        const msg = err instanceof ApiError ? err.message : "Something went wrong";
        showBanner({ kind: "error", text: msg });
      });
  }, [guildId, voiceChannelId, showBanner]);

  if (!authChecked) return <main className="min-h-full grid place-items-center"><span className="eyebrow">Loading…</span></main>;
  if (!me) return <LoginGate />;

  const snap = live.snapshot;
  return (
    <div className="min-h-full">
      <Grain />
      <div className="mx-auto max-w-4xl px-5 sm:px-8 py-7 flex flex-col gap-5">
        <ServerSelector me={me} activeGuildId={guildId} onSelect={setGuildId}
          onLogout={() => { api.logout().finally(() => (location.href = "/")); }} />
        {!guildId ? (
          <p className="card p-8 text-center" style={{ color: "var(--color-ink-dim)" }}>Pick a server to take the controls.</p>
        ) : (
          <>
            <NowPlaying item={snap?.current ?? null} />
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4 flex-wrap">
                <Controls onAction={control} paused={paused} disabled={!snap?.current} />
                <VoiceChannelPicker channels={channels} value={voiceChannelId} onChange={setVoiceChannelId} />
              </div>
              <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                {live.status === "live" ? "● live" : live.status === "forbidden" ? "✕ no access" : "○ " + live.status}
              </span>
            </div>
            {banner && <StatusBanner msg={banner} onDismiss={dismissBanner} />}
            <AddBar onPlay={onPlay} onPick={onPick} />
            <Queue items={snap?.upcoming ?? []} onRemove={(id) => guildId && api.remove(guildId, id).then(() => {}).catch(() => {})} onReorder={(id, toIndex) => guildId && api.reorder(guildId, id, toIndex).catch(() => {})} />
          </>
        )}
        <footer className="text-center font-mono text-xs pt-4" style={{ color: "var(--color-ink-faint)" }}>
          the real audio from the exact video — never a mirror track · YouTube Music Bot
        </footer>
      </div>
    </div>
  );
}
