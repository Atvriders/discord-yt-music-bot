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
  // Distinguishes "this guild legitimately has no voice channels" from "the fetch
  // failed" so the picker can show a recoverable error rather than vanishing silently.
  const [channelsLoadFailed, setChannelsLoadFailed] = useState(false);
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

  // Clear any pending auto-dismiss timer on unmount so it can't fire setBanner() on a
  // dead component (and avoids act()/strict-mode warnings in tests).
  useEffect(() => () => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
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

  const loadChannels = useCallback((g: string) => {
    setChannelsLoadFailed(false);
    api.voiceChannels(g).then((r) => {
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
    }).catch(() => {
      // Surface the failure (was silently swallowed) and flag it so the picker shows a
      // recoverable "couldn't load — retry" state instead of rendering nothing.
      setChannels([]);
      setChannelsLoadFailed(true);
      showBanner({ kind: "error", text: "Couldn't load voice channels" });
    });
  }, [showBanner]);

  useEffect(() => {
    if (!guildId) { setChannels([]); setVoiceChannelId(null); setChannelsLoadFailed(false); return; }
    loadChannels(guildId);
  }, [guildId, loadChannels]);

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

  // Returns a promise that REJECTS on failure so the ProgressBar can release its
  // optimistic hold (otherwise the bar stays pinned at the never-applied target with
  // a "seeking…" indicator forever, since a failed seek emits no confirming snapshot).
  const onSeek = useCallback((positionMs: number): Promise<void> => {
    if (!guildId) return Promise.resolve();
    return api.seek(guildId, positionMs).then(() => undefined).catch((err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Couldn't seek";
      showBanner({ kind: "error", text: msg });
      throw err;
    });
  }, [guildId, showBanner]);

  // Persist any settings patch. The authoritative values come back via the next WS
  // state broadcast (the controller emits "changed" on update), so we don't store the
  // result locally — the snapshot is the single source of truth.
  const onPatchSettings = useCallback(async (patch: Partial<GuildSettings>) => {
    if (!guildId) return;
    try {
      const { settings } = await api.setSettings(guildId, patch);
      // When the WS isn't live it won't deliver the "changed" frame, so the controlled
      // inputs would visually snap back to the stale snapshot value (looking like the
      // save failed). Merge the authoritative persisted settings into the snapshot so
      // the change is reflected immediately, mirroring the remove/reorder refresh.
      if (settings && live.status !== "live" && live.snapshot) {
        live.refresh({ ...live.snapshot, ...settings });
      }
    } catch (err) {
      const reason = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: `Couldn't update setting — ${reason}` });
    }
  }, [guildId, showBanner, live]);
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

  // Refetch the snapshot after a queue mutation when the WS isn't live to deliver
  // the update itself (otherwise the queue would look stale until the next event).
  const refreshIfNotLive = useCallback(async () => {
    if (!guildId || live.status === "live") return;
    try {
      const snap = await api.state(guildId);
      live.refresh(snap);
    } catch { /* a refetch failure is non-fatal; the mutation already succeeded */ }
  }, [guildId, live]);

  // Generation token: bumps on every guild switch. An in-flight resolve/pick that
  // started under an older generation must not write its result into the new guild.
  const genRef = useRef(0);
  useEffect(() => { genRef.current += 1; }, [guildId]);

  const onPlay = useCallback(async (input: string): Promise<{ candidates: TrackMeta[] | null; queuedTitle?: string }> => {
    if (!guildId) return { candidates: null };
    if (noVoiceTarget) {
      showBanner({ kind: "error", text: "Pick a voice channel first" });
      return { candidates: null };
    }
    // ITEM 5: show instant feedback — the resolve (yt-dlp) takes several seconds.
    const label = input.length > 60 ? input.slice(0, 57) + "…" : input;
    showBanner({ kind: "success", text: `Resolving ${label}…` });
    // Capture the generation so a guild switch mid-resolve invalidates stale results
    // rather than handing the old guild's candidates/queue to the new one.
    const gen = genRef.current;
    try {
      const r = await api.play(guildId, input, voiceChannelId ?? undefined);
      if (genRef.current !== gen) return { candidates: null }; // guild changed: drop stale result
      if (r.queued) {
        announceQueued(r);
        await refreshIfNotLive();
      } else {
        // A search returned candidates — drop the pending banner.
        dismissBanner();
      }
      return { candidates: r.candidates ?? null };
    } catch (err) {
      if (genRef.current !== gen) return { candidates: null };
      const msg = err instanceof ApiError ? err.message : "Something went wrong";
      showBanner({ kind: "error", text: msg });
      return { candidates: null };
    }
  }, [guildId, voiceChannelId, noVoiceTarget, showBanner, dismissBanner, announceQueued, refreshIfNotLive]);

  // Queue a single video and report the outcome (instead of mutating banner state
  // internally). The bulk path below aggregates these into one summary banner so
  // queuing N tracks no longer stomps N-1 results onto a single banner.
  const pickOne = useCallback(
    async (videoId: string): Promise<{ ok: boolean; title?: string; reason?: string }> => {
      if (!guildId) return { ok: false, reason: "No server selected" };
      if (noVoiceTarget) return { ok: false, reason: "Pick a voice channel first" };
      const gen = genRef.current;
      try {
        const r = await api.pick(guildId, videoId, voiceChannelId ?? undefined);
        // The guild changed while this pick was in flight — drop the stale result so
        // we never report (or refresh) into a now-different guild.
        if (genRef.current !== gen) return { ok: false, reason: "stale" };
        return { ok: true, title: r.queued?.title };
      } catch (err) {
        const reason = err instanceof ApiError ? err.message : "Something went wrong";
        return { ok: false, reason };
      }
    },
    [guildId, voiceChannelId, noVoiceTarget],
  );

  // Queue every selected candidate IN ORDER, serializing the picks so the server's
  // insertion order matches the candidate display order, then surface ONE aggregated
  // banner summarizing the batch (partial failures stay visible). Returns whether at
  // least one track was queued so the Picker can decide whether to close.
  const onQueueAll = useCallback(
    async (videoIds: string[]): Promise<boolean> => {
      if (videoIds.length === 0) return false;
      if (noVoiceTarget) {
        showBanner({ kind: "error", text: "Pick a voice channel first" });
        return false;
      }
      const results: { ok: boolean; title?: string; reason?: string }[] = [];
      for (const id of videoIds) results.push(await pickOne(id)); // sequential => ordered
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok && r.reason !== "stale");
      if (ok.length === 0 && failed.length === 0) return false; // all stale (guild switched)
      if (failed.length === 0) {
        showBanner({
          kind: "success",
          text:
            ok.length === 1 && ok[0]!.title
              ? `Queued: ${ok[0]!.title}`
              : `Queued ${ok.length} track${ok.length === 1 ? "" : "s"}`,
        });
      } else if (ok.length === 0) {
        const reason = failed[0]!.reason ?? "failed";
        showBanner({
          kind: "error",
          text:
            failed.length === 1
              ? `Couldn't queue — ${reason}`
              : `Couldn't queue any of the ${failed.length} selected tracks — ${reason}`,
        });
      } else {
        showBanner({
          kind: "error",
          text: `Queued ${ok.length} of ${ok.length + failed.length} (${failed.length} failed: ${failed[0]!.reason ?? "failed"})`,
        });
      }
      if (ok.length > 0) await refreshIfNotLive();
      return ok.length > 0;
    },
    [noVoiceTarget, pickOne, showBanner, refreshIfNotLive],
  );

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
                <VoiceChannelPicker
                  channels={channels}
                  value={voiceChannelId}
                  loadFailed={channelsLoadFailed}
                  onRetry={() => guildId && loadChannels(guildId)}
                  onChange={(id) => { manualChannelRef.current = true; setVoiceChannelId(id); }}
                />
                <Settings
                  idleTimeoutSec={snap?.idleTimeoutSec}
                  crossfadeSec={snap?.crossfadeSec}
                  normalizeLoudness={snap?.normalizeLoudness}
                  repeat={snap?.repeat}
                  autoplay={snap?.autoplay}
                  autoplaySource={snap?.autoplaySource}
                  maxTrackDurationSec={snap?.maxTrackDurationSec}
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
            <AddBar onPlay={onPlay} onQueueAll={onQueueAll} busy={noVoiceTarget} />
            <Discover onSearch={onPlay} onQueueAll={onQueueAll} busy={noVoiceTarget} />
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
