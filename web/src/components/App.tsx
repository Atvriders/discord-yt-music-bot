import { useCallback, useEffect, useState } from "react";
import type { Me, TrackMeta, VoiceChannel } from "../types.js";
import { api, type ControlAction } from "../lib/api.js";
import { useGuildState } from "../lib/useGuildState.js";
import { Grain } from "./Grain.js";
import { LoginGate } from "./LoginGate.js";
import { ServerSelector } from "./ServerSelector.js";
import { NowPlaying } from "./NowPlaying.js";
import { Controls } from "./Controls.js";
import { Queue } from "./Queue.js";
import { AddBar } from "./AddBar.js";
import { VoiceChannelPicker } from "./VoiceChannelPicker.js";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [voiceChannelId, setVoiceChannelId] = useState<string | null>(null);
  const live = useGuildState(guildId);

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

  const onPlay = useCallback(async (input: string): Promise<TrackMeta[] | null> => {
    if (!guildId) return null;
    const r = await api.play(guildId, input, voiceChannelId ?? undefined);
    return r.candidates ?? null;
  }, [guildId, voiceChannelId]);

  if (!authChecked) return <main className="min-h-full grid place-items-center"><span className="eyebrow">tuning in…</span></main>;
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
            <AddBar onPlay={onPlay} onPick={(v) => guildId && api.pick(guildId, v, voiceChannelId ?? undefined).catch(() => {})} />
            <Queue items={snap?.upcoming ?? []} onRemove={(id) => guildId && api.remove(guildId, id).then(() => {}).catch(() => {})} onReorder={(id, toIndex) => guildId && api.reorder(guildId, id, toIndex).catch(() => {})} />
          </>
        )}
        <footer className="text-center font-mono text-xs pt-4" style={{ color: "var(--color-ink-faint)" }}>
          plays the exact link, nothing else · yt music bot
        </footer>
      </div>
    </div>
  );
}
