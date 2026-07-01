import type { Bot } from "../types.js";

/**
 * The "bot bank" — a rack of tactile console keys, one per Discord bot in the fleet, the
 * active one lit red (matching the ServerSelector's guild bank). Each bot runs its own
 * player in its own voice channel, so selecting a bot swaps the whole panel to that bot's
 * guilds + live state.
 *
 * In a single-bot deployment this collapses to a quiet engraved plate showing the one
 * bot's name (no interactive keys) so the panel looks/behaves exactly as it did before
 * the fleet existed.
 *
 * `playingBotIds` marks bots that currently have something on air — surfaced as a small
 * red "● live" jewel next to the name so the operator can see at a glance which decks are
 * running without switching to them.
 */
export function BotPicker({ bots, activeBotId, playingBotIds, onSelect }: {
  bots: Bot[];
  activeBotId: string | null;
  /** Ids of bots that are currently playing something — shown as a small live jewel. */
  playingBotIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  // Nothing to pick from — render nothing (the panel handles the empty/standby state).
  if (bots.length === 0) return null;

  // Single-bot deployments keep the pre-fleet experience: a static engraved label, no
  // interactive rack. We still show it (compact) so the operator knows which bot they're
  // driving, but there is nothing to switch between.
  const single = bots.length === 1;

  return (
    <div
      className="flex items-center gap-3 min-w-0"
      role="group"
      aria-label="Bot"
    >
      {/* Machined "deck" glyph so the bot bank reads distinctly from the server bank. */}
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.6rem",
          height: "1.6rem",
          borderRadius: "var(--radius-sm)",
          flex: "0 0 auto",
          color: "var(--color-ember-soft)",
          background: "var(--color-sunken)",
          boxShadow: "var(--shadow-inset)",
          fontSize: "0.85rem",
        }}
      >
        ◈
      </span>
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="eyebrow">Bot</span>
        {single ? (
          // One bot: a quiet label plate, not a button — nothing to toggle.
          <span
            className="font-display truncate"
            style={{ fontSize: "1.05rem", color: "var(--color-ink)", lineHeight: 1.1 }}
          >
            {bots[0]!.name}
            {playingBotIds?.has(bots[0]!.id) && (
              <span
                className="font-mono"
                aria-label="on air"
                style={{
                  marginLeft: "0.5rem",
                  fontSize: "0.6rem",
                  color: "var(--color-ember-soft)",
                  letterSpacing: "0.04em",
                  textShadow: "0 0 10px rgba(255,0,0,0.55)",
                }}
              >
                ● live
              </span>
            )}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {bots.map((b) => {
              const active = b.id === activeBotId;
              const playing = playingBotIds?.has(b.id) ?? false;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelect(b.id)}
                  className="pill"
                  aria-pressed={active}
                  aria-label={`${b.name}${playing ? " (playing)" : ""}${active ? " (selected)" : ""}`}
                  title={playing ? `${b.name} — playing` : b.name}
                  style={
                    active
                      ? { borderColor: "var(--color-ember)", color: "var(--color-ember-soft)", padding: "0.4rem 0.9rem", fontSize: "0.85rem" }
                      : { padding: "0.4rem 0.9rem", fontSize: "0.85rem" }
                  }
                >
                  {/* A small live jewel for a bot that's on air (even when not selected),
                      so the operator sees which decks are running at a glance. */}
                  {playing && (
                    <span
                      aria-hidden="true"
                      style={{
                        width: "0.42rem",
                        height: "0.42rem",
                        borderRadius: "50%",
                        background: "var(--color-ember)",
                        boxShadow: "0 0 8px 0 rgba(255,0,0,0.75)",
                        flex: "0 0 auto",
                      }}
                    />
                  )}
                  {b.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
