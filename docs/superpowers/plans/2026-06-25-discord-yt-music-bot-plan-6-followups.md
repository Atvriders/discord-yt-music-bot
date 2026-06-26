# discord-yt-music-bot — Plan 6: Feature Follow-ups

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). The frontend tasks keep the locked "After-Hours" aesthetic (reuse existing classes/components).

**Goal:** Close the three deferred follow-ups: (1) admin **mid-session channel-move** (the bot relocates to an admin's channel, resuming the current track); (2) the **voice-channel picker** in the web panel (wire the existing `/api/guilds/:id/voice-channels` endpoint so the web can start playback in a chosen channel cold); (3) **queue reorder** controls in the panel (wire the existing `api.reorder`).

**Architecture:** T1 is backend — restore `move` to `selectVoiceChannel`, refactor `GuildController.playNextLocked` to extract a reusable `playItemLocked`, add `GuildController.moveTo`, and wire `move` through the Discord handlers + bot + REST play. T2/T3 are frontend — a `VoiceChannelPicker` (consumes `api.voiceChannels`, App tracks the selected channel and threads it into `play`/`pick`) and up/down reorder buttons in `Queue` (consume `api.reorder`).

**Spec:** [design spec](../specs/2026-06-25-discord-yt-music-bot-design.md) §6.1 (admin move), §10 (panel: queue reorder, channel selection).

**Consumes:** `GuildController` (`ensureConnected`, `queue`, `session`, the `lock` Mutex, `ensureDownloaded`/`makeResource`/`cache` deps), `VoiceSession.channelId`, `selectVoiceChannel`/`VoiceTarget` (Plan 2), the handlers/bot (Plan 2), `rest.ts` (Plan 3), the `api` client + `Queue`/`AddBar`/`App` (Plan 4).

## Global Constraints

- Node 22.12+, ESM NodeNext (**`.js` imports**), strict TS, no DOM in backend tsconfig (web is the DOM exception). Aesthetic LOCKED for the UI.
- **Single-pop invariant preserved:** only `queue.advance()` pops `current`. `moveTo` resumes the *existing* `current` via `playItemLocked` (no advance) or starts the queue via `playNextLocked`; it never double-advances.
- **`moveTo` runs inside the per-controller `Mutex` and must NOT call the locked `ensureConnected`** (the Mutex is not reentrant) — it inlines the session create/teardown.
- Mid-session move **restarts the current track from 0** in the new channel (no mid-track position resume — same scope decision as the snapshot).
- The voice-channel picker only enables a cold-start join; once connected, web adds enqueue to the existing session as before.
- Commits conventional; branch `plan-6-followups`; squash-merge at the end.

---

### Task 1: Admin mid-session channel-move (backend)

**Files:** `src/orchestrator/voice-selection.ts` (+test), `src/orchestrator/index.ts` (+test), `src/discord/handlers.ts` (+test), `src/discord/bot.ts`, `src/server/rest.ts` (+test).

- [ ] **Step 1: Restore `move` to `selectVoiceChannel`** (revert the Plan 2 descope). Update `src/orchestrator/voice-selection.ts`:
```ts
export type VoiceTarget =
  | { ok: true; channelId: string; move: boolean }
  | { ok: false; reason: string };

export function selectVoiceChannel(ctx: SelectionContext): VoiceTarget {
  if (!ctx.requesterChannelId) return { ok: false, reason: "Join a voice channel first." };
  if (!ctx.botChannelId || ctx.botChannelId === ctx.requesterChannelId) {
    return { ok: true, channelId: ctx.requesterChannelId, move: false };
  }
  if (ctx.isAdmin) return { ok: true, channelId: ctx.requesterChannelId, move: true };
  return { ok: false, reason: "I'm already playing in another channel." };
}
```
Update `voice-selection.test.ts`: the admin-different case now asserts `{ ok: true, channelId: "A", move: true }`; the join + same-channel cases assert `move: false`.

- [ ] **Step 2: Refactor `GuildController` + add `moveTo`** (`src/orchestrator/index.ts`). Extract `playItemLocked` from `playNextLocked`, add `connectSessionLocked`, and `moveTo`:
```ts
  // Plays a specific item in the current session WITHOUT advancing the queue. Returns false on failure.
  private async playItemLocked(item: QueueItem): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    try {
      const path = await this.ensureDownloaded(item.meta.videoId);
      this.deps.cache.pin(item.meta.videoId);
      this.pinned.add(item.meta.videoId);
      session.play(await this.deps.makeResource(path, item));
      return true;
    } catch {
      return false;
    }
  }

  private async playNextLocked(): Promise<void> {
    const session = this.session;
    if (!session) return;
    let item = await this.queue.advance();
    while (item) {
      if (await this.playItemLocked(item)) return;
      item = await this.queue.advance();
    }
    session.startIdleTimer();
  }

  // Inline session create + listener wiring (shared by ensureConnected and moveTo; NOT locked itself).
  private async connectSessionLocked(channelId: string): Promise<void> {
    const session = await this.deps.createSession(channelId);
    session.on("trackEnd", () => void this.playNext());
    session.on("error", () => void this.playNext());
    session.on("idle", () => void this.leave());
    this.session = session;
  }

  async ensureConnected(channelId: string): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (this.session) return;
      await this.connectSessionLocked(channelId);
    });
  }

  /** Admin move: relocate to a new channel, resuming the current track from 0 (or starting the queue). */
  async moveTo(channelId: string): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (this.session && this.session.channelId === channelId) return; // already there
      const current = this.queue.current;
      this.session?.destroy();
      this.session = null;
      await this.connectSessionLocked(channelId);
      if (current) await this.playItemLocked(current);
      else await this.playNextLocked();
    });
  }
```
(`makeResource` is already awaited per Plan 2 Task 8; `connectedChannelId`/`restore` from Plan 5 are unaffected.) Existing orchestrator tests must still pass; add a `moveTo` test (fake session with a `channelId`): moving while a current is set destroys the old session, creates a new one for the new channel, and plays the current item (not advancing).

- [ ] **Step 3: Wire `move` into the Discord handler** (`src/discord/handlers.ts`). In `handlePlay`, after a successful `selectVoiceChannel` for a `video`:
```ts
  if (!target.ok) return msg(`❌ ${target.reason}`);
  if (target.move) await ctx.controller.moveTo(target.channelId);
  else await ctx.controller.ensureConnected(target.channelId);
  await ctx.controller.enqueue(meta, ctx.requester);
```
Add `moveTo` to the `HandlerContext.controller` `Pick<...>`. Update a handler test: with `isAdmin:true` + `botChannelId` different from `requesterChannelId`, `controller.moveTo` is called (not `ensureConnected`).

- [ ] **Step 4: Wire `move` into the bot's button handler** (`src/discord/bot.ts`) — the `interactionCreate` pick path computes `target` already; change `await controller.ensureConnected(target.channelId)` to `if (target.move) await controller.moveTo(target.channelId); else await controller.ensureConnected(target.channelId);`.

- [ ] **Step 5: Wire `move` into REST play/pick** (`src/server/rest.ts`). The web has no "requester voice channel" — it passes `voiceChannelId` explicitly. When `voiceChannelId` is provided AND the caller is an admin AND the bot is connected elsewhere, use `moveTo`. Simplest: in `enqueueVideo`, if `body.voiceChannelId` is provided, call `await controller.ensureConnected(voiceChannelId)`; additionally, if the controller is already connected to a *different* channel and the user is an admin, call `await controller.moveTo(voiceChannelId)`. Implement via a small check:
```ts
  if (body.voiceChannelId) {
    const connected = controller.connectedChannelId;
    if (connected && connected !== body.voiceChannelId && isAdmin(req)) {
      await controller.moveTo(body.voiceChannelId);
    } else {
      await controller.ensureConnected(body.voiceChannelId);
    }
  }
```
Add `connectedChannelId` + `moveTo` to the REST `Controller` interface; add an `isAdmin(req)` helper (the session user id ∈ `deps.adminIds`). Add a rest.test case: an admin posting play with a different `voiceChannelId` while connected triggers `moveTo`.

- [ ] **Step 6: Verify + commit** — `npm test && npm run typecheck && npm run lint && npm run build` green. `git commit -m "feat(voice): admin mid-session channel-move (selection + moveTo + wiring)"`.

---

### Task 2: Voice-channel picker (web panel)

**Files:** `web/src/components/VoiceChannelPicker.tsx`, `web/src/components/App.tsx`, `web/src/components/AddBar.tsx`, `web/src/App.test.tsx` (extend).

- [ ] **Step 1: `web/src/components/VoiceChannelPicker.tsx`** (After-Hours styled select):
```tsx
import type { VoiceChannel } from "../types.js";

export function VoiceChannelPicker({ channels, value, onChange }: {
  channels: VoiceChannel[]; value: string | null; onChange: (id: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-ink-dim)" }}>
      <span className="eyebrow">Channel</span>
      <select aria-label="Voice channel" value={value ?? ""} onChange={(e) => onChange(e.target.value)}
        className="bg-transparent rounded-lg px-3 py-2 text-sm"
        style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }}>
        <option value="" disabled>pick a channel…</option>
        {channels.map((c) => (<option key={c.id} value={c.id} style={{ background: "var(--color-raised)" }}>{c.name}</option>))}
      </select>
    </label>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx`** — fetch channels per guild, track the selected channel, thread it into play/pick:
```tsx
  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [voiceChannelId, setVoiceChannelId] = useState<string | null>(null);
  useEffect(() => {
    if (!guildId) { setChannels([]); setVoiceChannelId(null); return; }
    api.voiceChannels(guildId).then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, [guildId]);
```
Pass `voiceChannelId ?? undefined` into the play/pick calls: change `onPlay` to `api.play(guildId, input, voiceChannelId ?? undefined)` and the AddBar `onPick` to `api.pick(guildId, v, voiceChannelId ?? undefined)`. Render `<VoiceChannelPicker channels={channels} value={voiceChannelId} onChange={setVoiceChannelId} />` in the controls row (next to the live-status indicator). Import `VoiceChannel` from `../types.js` and the picker.

- [ ] **Step 3: Extend `App.test.tsx`** — the logged-in test's fetch mock must also answer `/api/guilds/G1/voice-channels` (return `{ channels: [{id:"C1",name:"General"}] }`) and `/api/guilds/G1/state`. Use a `fetch` mock that routes by URL (a `vi.fn((url) => …)` returning the right body per path) so the existing "panel shows" assertion still passes and you can additionally assert the channel option `General` renders. Keep both existing test cases green.

- [ ] **Step 4: Verify + commit** — `npm test && npm run typecheck && npm run lint && npm run build` green. `git commit -m "feat(web): voice-channel picker for cold-start playback"`.

---

### Task 3: Queue reorder controls (web panel)

**Files:** `web/src/components/Queue.tsx`, `web/src/components/App.tsx`.

- [ ] **Step 1: Add move-up/down to `Queue.tsx`** — extend the props with `onReorder(itemId, toIndex)` and render small ▲/▼ buttons per row (disabled at the ends), reusing the pill/ghost styling:
```tsx
export function Queue({ items, onRemove, onReorder }: {
  items: QueueItem[]; onRemove: (itemId: string) => void; onReorder: (itemId: string, toIndex: number) => void;
}) {
  // ...inside the <li> row, before the Remove button:
  //   <button aria-label="Move up" disabled={i === 0} onClick={() => onReorder(it.id, i - 1)}
  //     className="pill" style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}>▲</button>
  //   <button aria-label="Move down" disabled={i === items.length - 1} onClick={() => onReorder(it.id, i + 1)}
  //     className="pill" style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}>▼</button>
}
```
(Show the up/down buttons in the same `opacity-0 group-hover:opacity-100` cluster as Remove, or always-visible — keep it tasteful and aesthetic-consistent.)

- [ ] **Step 2: Wire `onReorder` in `App.tsx`** — `onReorder={(id, toIndex) => guildId && api.reorder(guildId, id, toIndex).catch(() => {})}`.

- [ ] **Step 3: Verify + commit** — `npm test && npm run typecheck && npm run lint && npm run build` green. `git commit -m "feat(web): queue reorder controls"`.

---

### Task 4: Docs + final verification

**Files:** `README.md`.

- [ ] **Step 1: Update `README.md`** — remove the "known limitation" lines about reorder/voice-channel/admin-move now that they're wired; the manual-verify checklist gains: admin can move the bot to their channel mid-session (current track resumes); the panel's channel picker starts playback cold; the queue ▲/▼ reorder works and updates live.
- [ ] **Step 2: Final verification** — `npm test && npm run typecheck && npm run lint && npm run build` all green.
- [ ] **Step 3: Commit** — `docs: update README for admin-move, channel picker, and reorder`.

---

## Self-Review

**1. Spec coverage:** §6.1 admin mid-session move (selection `move` + `GuildController.moveTo` + Discord/REST wiring) → T1 ✔; §10 panel channel selection (voice-channel picker consuming the Plan 5… Plan 3 endpoint) → T2 ✔; §10 panel queue reorder (▲/▼ → `api.reorder`) → T3 ✔. Removes the three "intentional follow-up" deferrals documented at the end of Plans 2/4.

**2. Placeholder scan:** none — T1 has full code + tests; T2/T3 give the components + the exact App wiring; the inline-comment JSX in T3 is the literal markup to place in the existing row.

**3. Type consistency:** `VoiceTarget.move` (T1) consumed by handlers (T1.3), bot (T1.4), REST (T1.5); `GuildController.moveTo`/`connectedChannelId` (T1.2) consumed by handlers/bot/REST; `playItemLocked` is internal (used by `playNextLocked` + `moveTo`). `api.voiceChannels`/`VoiceChannel` (Plan 3/4) consumed by the picker (T2); `api.reorder` (Plan 4) consumed by Queue (T3). `voiceChannelId` threads App → AddBar/play/pick.

**4. Invariant safety:** `moveTo` resumes via `playItemLocked` (no advance) when a `current` exists, or `playNextLocked` (single advance) when starting fresh — the single-pop invariant holds; it runs inside the existing `Mutex` and avoids the non-reentrant `ensureConnected`. The `playNextLocked` refactor is behavior-preserving (verified by the unchanged orchestrator tests).
