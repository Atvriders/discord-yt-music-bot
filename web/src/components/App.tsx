import { useCallback, useEffect, useRef, useState } from "react";
import type { GuildSettings, Me, TrackMeta, VoiceChannel } from "../types.js";
import { api, ApiError, type ControlAction } from "../lib/api.js";
import { useGuildState } from "../lib/useGuildState.js";
import { Grain } from "./Grain.js";
import { LoginGate } from "./LoginGate.js";
import { ServerSelector } from "./ServerSelector.js";
import { NowPlaying } from "./NowPlaying.js";
import { Controls } from "./Controls.js";
import { Queue } from "./Queue.js";
import { AddBar } from "./AddBar.js";
import { Discover } from "./Discover.js";
import { VoiceChannelPicker } from "./VoiceChannelPicker.js";
import { Settings } from "./Settings.js";

type BannerMsg = { kind: "success"; text: string } | { kind: "error"; text: string };

const GUILD_STORAGE_KEY = "ytbot.guildId";

function readStoredGuildId(): string | null {
  try { return localStorage.getItem(GUILD_STORAGE_KEY); } catch { return null; }
}

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
  // True once the user manually picks a channel for this guild, so later channel
  // refreshes don't clobber their choice with the auto-detected current channel.
  const manualChannelRef = useRef(false);
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

  // Reconcile the pause/resume label with server truth: the server now broadcasts
  // a fresh snapshot on every pause/resume, so the optimistic toggle is corrected
  // (or confirmed) by the authoritative `paused` flag on the next WS state message.
  const serverPaused = live.snapshot?.paused;
  useEffect(() => {
    if (typeof serverPaused === "boolean") setPaused(serverPaused);
  }, [serverPaused]);

  // Reset manual-pick tracking when the active guild changes.
  useEffect(() => { manualChannelRef.current = false; }, [guildId]);

  useEffect(() => {
    if (!guildId) { setChannels([]); setVoiceChannelId(null); return; }
    api.voiceChannels(guildId).then((r) => {
      setChannels(r.channels);
      // ITEM 2: auto-select the voice channel the user is currently in, unless
      // they've already picked one manually (manual choice must win).
      if (
        !manualChannelRef.current &&
        r.currentChannelId &&
        r.channels.some((c) => c.id === r.currentChannelId)
      ) {
        setVoiceChannelId(r.currentChannelId);
      }
    }).catch(() => setChannels([]));
  }, [guildId]);

  useEffect(() => {
    api.me().then((m) => {
      setMe(m);
      // ITEM 1: prefer the last-selected guild (if still controllable), else the first.
      setGuildId((g) => {
        if (g) return g;
        const stored = readStoredGuildId();
        if (stored && m.guilds.some((x) => x.id === stored)) return stored;
        return m.guilds[0]?.id ?? null;
      });
    }).catch(() => setMe(null)).finally(() => setAuthChecked(true));
  }, []);

  // ITEM 1: persist the chosen guild so it is remembered next visit.
  useEffect(() => {
    if (!guildId) return;
    try { localStorage.setItem(GUILD_STORAGE_KEY, guildId); } catch { /* ignore */ }
  }, [guildId]);

  const control = useCallback(async (a: ControlAction) => {
    if (!guildId) return;
    // Optimistic toggle for the pause/resume label.
    if (a === "pause") setPaused(true);
    if (a === "resume") setPaused(false);
    try {
      await api.control(guildId, a);
    } catch (err) {
      // Revert the optimistic toggle and surface the failure — a swallowed error
      // made a failed pause look like it succeeded while audio kept playing.
      if (a === "pause") setPaused(false);
      if (a === "resume") setPaused(true);
      const reason = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: `Couldn't ${a} — ${reason}` });
    }
  }, [guildId, showBanner]);

  const onSeek = useCallback((positionMs: number) => {
    if (!guildId) return;
    api.seek(guildId, positionMs).catch((err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Couldn't seek";
      showBanner({ kind: "error", text: msg });
    });
  }, [guildId, showBanner]);

  // Persist any settings patch. The authoritative values come back via the next WS
  // state broadcast (the controller emits "changed" on update), so we don't store the
  // result locally — the snapshot is the single source of truth.
  const onPatchSettings = useCallback(async (patch: Partial<GuildSettings>) => {
    if (!guildId) return;
    try {
      await api.setSettings(guildId, patch);
    } catch (err) {
      const reason = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: `Couldn't update setting — ${reason}` });
    }
  }, [guildId, showBanner]);
  const onSetIdleTimeout = useCallback(
    (idleTimeoutSec: number) => onPatchSettings({ idleTimeoutSec }),
    [onPatchSettings],
  );

  // Whether an enqueue would queue into the void: no channel picked AND the bot is
  // not already playing anything in this guild. Used to short-circuit add attempts
  // with a clear prompt rather than a false "Queued" (the backend also rejects this).
  const noVoiceTarget = !voiceChannelId && !live.snapshot?.current;

  // Surface a successful enqueue, including the non-admin move-suppressed case.
  const announceQueued = useCallback((r: { queued?: { id: string; title: string }; moveSuppressed?: { requested: string; actual: string | null } }) => {
    if (!r.queued) return;
    if (r.moveSuppressed) {
      showBanner({ kind: "success", text: `Queued: ${r.queued.title} — only an admin can move the bot` });
    } else {
      showBanner({ kind: "success", text: `Queued: ${r.queued.title}` });
    }
  }, [showBanner]);

  const onPlay = useCallback(async (input: string): Promise<{ candidates: TrackMeta[] | null; queuedTitle?: string }> => {
    if (!guildId) return { candidates: null };
    if (noVoiceTarget) {
      showBanner({ kind: "error", text: "Pick a voice channel first" });
      return { candidates: null };
    }
    // ITEM 5: show instant feedback — the resolve (yt-dlp) takes several seconds.
    const label = input.length > 60 ? input.slice(0, 57) + "…" : input;
    showBanner({ kind: "success", text: `Resolving ${label}…` });
    try {
      const r = await api.play(guildId, input, voiceChannelId ?? undefined);
      if (r.queued) {
        announceQueued(r);
      } else {
        // A search returned candidates — drop the pending banner.
        dismissBanner();
      }
      return { candidates: r.candidates ?? null };
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: msg });
      return { candidates: null };
    }
  }, [guildId, voiceChannelId, noVoiceTarget, showBanner, dismissBanner, announceQueued]);

  const onPick = useCallback((videoId: string) => {
    if (!guildId) return;
    if (noVoiceTarget) {
      showBanner({ kind: "error", text: "Pick a voice channel first" });
      return;
    }
    api.pick(guildId, videoId, voiceChannelId ?? undefined)
      .then((r) => announceQueued(r))
      .catch((err: unknown) => {
        const msg = err instanceof ApiError ? err.message : "Something went wrong";
        showBanner({ kind: "error", text: msg });
      });
  }, [guildId, voiceChannelId, noVoiceTarget, showBanner, announceQueued]);

  // Refetch the snapshot after a queue mutation when the WS isn't live to deliver
  // the update itself (otherwise the queue would look stale until the next event).
  const refreshIfNotLive = useCallback(async () => {
    if (!guildId || live.status === "live") return;
    try {
      const snap = await api.state(guildId);
      live.refresh(snap);
    } catch { /* a refetch failure is non-fatal; the mutation already succeeded */ }
  }, [guildId, live]);

  const onRemove = useCallback(async (itemId: string) => {
    if (!guildId) return;
    try {
      await api.remove(guildId, itemId);
      await refreshIfNotLive();
    } catch (err) {
      const reason = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: `Couldn't remove — ${reason}` });
    }
  }, [guildId, refreshIfNotLive, showBanner]);

  const onReorder = useCallback(async (itemId: string, toIndex: number) => {
    if (!guildId) return;
    try {
      await api.reorder(guildId, itemId, toIndex);
      await refreshIfNotLive();
    } catch (err) {
      const reason = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: `Couldn't move — ${reason}` });
    }
  }, [guildId, refreshIfNotLive, showBanner]);

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
            <NowPlaying
              item={snap?.current ?? null}
              paused={snap?.paused ?? false}
              playing={!!snap?.current && !paused}
              receivedAt={live.receivedAt}
              canSeek={live.status === "live" && !!snap?.current}
              onSeek={onSeek}
            />
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4 flex-wrap">
                <Controls onAction={control} paused={paused} disabled={!snap?.current} />
                <VoiceChannelPicker channels={channels} value={voiceChannelId} onChange={(id) => { manualChannelRef.current = true; setVoiceChannelId(id); }} />
                <Settings
                  idleTimeoutSec={snap?.idleTimeoutSec}
                  crossfadeSec={snap?.crossfadeSec}
                  normalizeLoudness={snap?.normalizeLoudness}
                  repeat={snap?.repeat}
                  disabled={live.status === "forbidden"}
                  onChange={onSetIdleTimeout}
                  onAudioChange={onPatchSettings}
                />
              </div>
              <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                {live.status === "live" ? "● live" : live.status === "forbidden" ? "✕ no access" : "○ " + live.status}
              </span>
            </div>
            {banner && <StatusBanner msg={banner} onDismiss={dismissBanner} />}
            <AddBar onPlay={onPlay} onPick={onPick} busy={noVoiceTarget} />
            <Discover onSearch={onPlay} onPick={onPick} busy={noVoiceTarget} />
            <Queue items={snap?.upcoming ?? []} onRemove={onRemove} onReorder={onReorder} />
          </>
        )}
        <footer className="text-center font-mono text-xs pt-4" style={{ color: "var(--color-ink-faint)" }}>
          the real audio from the exact video — never a mirror track · YouTube Music Bot
        </footer>
      </div>
    </div>
  );
}
