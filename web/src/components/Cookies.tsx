import { useCallback, useEffect, useRef, useState } from "react";
import type { CookieHealth, CookieResult, CookieSource } from "../types.js";
import { api, ApiError } from "../lib/api.js";

/** Which operation currently owns the panel (null = idle). */
type Op = "load" | "test" | "save" | "import";

/**
 * An action's outcome, tagged with the op so the banner can name what just happened.
 *
 * `warning` is orthogonal to `ok`. The server sets it when the operation SUCCEEDED but the
 * operator still needs to know something — a jar saved with no sign-in cookie in it, or an
 * import that had to drop cookies it could not decrypt. It is prose the server wrote; like
 * `reason` it never contains a cookie name or value, and it renders ALONGSIDE the success
 * line rather than replacing it.
 */
type OpResult = {
  op: Exclude<Op, "load">;
  ok: boolean;
  reason: string | null;
  warning: string | null;
};

const SOURCE_LABEL: Record<CookieSource, string> = {
  env: "from the deploy config",
  paste: "pasted into this console",
  browser: "imported from the browser profile",
  none: "no jar on disk",
};

/**
 * The console's two lamp colours, in this deck's grammar: RED is the on-air signal (the same
 * red the VU needles and the now-playing rail use), AMBER is the fault lamp. Red-on-red would
 * have made "passing" and "refused" the same colour, so the caution state borrows the VU's
 * upper-band gold instead. Colour is never the only cue — every state also carries a word
 * ("Passing" / "Refused") and, when it matters, a lit left rail.
 */
const LAMP_LIVE = "var(--color-ember)";
const LAMP_FAULT = "var(--color-gold)";
/** #ff0000 is punchy as a fill and thin as body text; the hotter sibling reads better inline. */
const TEXT_LIVE = "var(--color-ember-soft)";

/** Per-tab storage key for the console password. Never a cookie, never localStorage. */
const ADMIN_KEY = "ytbot.cookieAdmin";

/**
 * The URL fragment that reveals the console while it is still locked.
 *
 * THIS IS DISCOVERABILITY, NOT A SECURITY BOUNDARY. The boundary is COOKIE_ADMIN_PASSWORD,
 * checked server-side on every /api/cookies call; someone who guesses the hash gets the
 * password prompt and nothing else — no health, no buttons, no account. All the hash buys is
 * that an ordinary guild member, who came here to queue a song, is never shown an admin control
 * they cannot use and should not be poking at. Never treat it as access control.
 */
const REVEAL_HASH = "#cookies";

/** "just now" / "14 min ago" / "3 h ago" / "6 d ago". null → "never". */
function ago(at: number | null): string {
  if (at === null) return "never";
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

/** Absolute timestamp for the tooltip behind every relative time. */
function stamp(at: number | null): string | undefined {
  return at === null ? undefined : new Date(at).toLocaleString();
}

/** The lamp + headline, derived from the health response. `bad` drives the alarm rule. */
function readState(h: CookieHealth): {
  live: boolean;
  bad: boolean;
  tally: string;
  headline: string;
  detail: string;
} {
  if (!h.configured) {
    return {
      live: false,
      bad: true,
      tally: "No cookies",
      headline: "No cookies are configured.",
      detail:
        "YouTube will refuse age-restricted videos and may demand a sign-in on a flagged IP — paste a jar below, or import one from the browser.",
    };
  }
  if (h.lastCheck === null) {
    return {
      live: false,
      bad: false,
      tally: "Unchecked",
      headline: "Cookies are loaded, but unverified.",
      detail: "Run a test to find out whether YouTube still accepts this session.",
    };
  }
  if (h.lastCheck.ok) {
    return {
      live: true,
      bad: false,
      tally: "Passing",
      headline: "YouTube is accepting these cookies.",
      detail: "The last real extraction went through.",
    };
  }
  return {
    live: false,
    bad: true,
    tally: "Refused",
    headline: "YouTube is refusing us.",
    detail: h.lastCheck.reason ?? "The last extraction was rejected.",
  };
}

/** Friendly text for a REST failure (these endpoints never return cookie data). */
function requestMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    return e.status === 401 ? "Session expired — reload and log in again." : e.message || fallback;
  }
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Pull the optional `warning` off a result, collapsing blank/whitespace-only values to null. */
function warningOf(r: CookieResult): string | null {
  const w = (r as { warning?: unknown }).warning;
  return typeof w === "string" && w.trim() !== "" ? w : null;
}

/**
 * The cookie console — an OPERATOR panel, collapsed by default and parked at the very bottom of
 * the deck so it never crowds the playback UI.
 *
 * yt-dlp needs a signed-in YouTube session to get past "Sign in to confirm you are not a bot"
 * and to play age-restricted videos, and that session expires every few weeks. This panel is how
 * the owner sees the jar's health and replaces it without editing docker-compose or restarting
 * the container: paste an export, or pull the cookies straight out of the LAN-only browser
 * sidecar's profile.
 *
 * It is deliberately NOT bot- or guild-scoped: every bot in the process shares one extractor and
 * therefore one cookie jar.
 *
 * Two rules shape everything here:
 *  - COOKIE VALUES ARE NEVER DISPLAYED. /api/cookies returns health only — no cookie name or
 *    value appears in any response — and this component never asks for one back, never keeps a
 *    pasted jar around after it has been applied, and renders status text only.
 *  - TEST AND IMPORT ARE SLOW. Both run a real yt-dlp extraction against YouTube, which
 *    routinely takes many seconds. So every action has a spinner, honest pending copy, and locks
 *    the other buttons; `busy` is always released in a finally, never left stranded.
 *
 * Health is fetched lazily on first open — a maintenance endpoint should not be hit by every
 * listener's browser on every page load. Once we HAVE looked, a failing check also marks the
 * collapsed toggle, so a closed panel can still raise its hand.
 */
export function Cookies() {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<CookieHealth | null>(null);
  const [busy, setBusy] = useState<Op | null>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<OpResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The console's OWN password, separate from the Discord login that any guild member has. Held
  // per-tab in sessionStorage (never a cookie, never localStorage): closing the tab re-locks it,
  // and it is only ever sent as the x-cookie-admin request header.
  const [admin, setAdmin] = useState<string>(() => {
    try {
      return sessionStorage.getItem(ADMIN_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [adminDraft, setAdminDraft] = useState("");
  // "disabled" = the server has no COOKIE_ADMIN_PASSWORD set, so the console does not exist here.
  // "locked"   = configured, but this tab has not supplied the right password yet.
  const [gate, setGate] = useState<"unknown" | "disabled" | "locked" | "open">("unknown");
  // A test/import can outlive the panel; drop late responses instead of setting state.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // The live URL fragment, so the locked console can appear the moment the operator types
  // #cookies — no reload, and no polling. See REVEAL_HASH: this is discoverability only.
  const [hash, setHash] = useState<string>(() => window.location.hash);
  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash);
    // Resync once on attach: the hash can change between the initial render and this effect
    // (an in-page anchor click during mount), and nothing would fire hashchange for us then.
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const h = await api.cookies(admin);
      if (!aliveRef.current) return;
      setHealth(h);
      setGate("open");
      setLoadError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 404) {
        // Not configured on this server: show nothing at all rather than a teasing locked box.
        setGate("disabled");
        setLoadError(null);
        return;
      }
      if (status === 403) {
        setGate("locked");
        setLoadError(null);
        // A stored password that no longer works is worse than none — drop it so the prompt shows.
        try {
          sessionStorage.removeItem(ADMIN_KEY);
        } catch {
          /* private mode / storage disabled — the in-memory value below is enough */
        }
        setAdmin("");
        return;
      }
      setLoadError(requestMessage(e, "Couldn't read the cookie status."));
    }
  }, [admin]);

  // Probe once on mount, and again whenever the console password changes — that second case IS
  // the unlock: submitting the form sets `admin`, refresh() re-runs with it, and the gate flips.
  // Without a mount probe the component cannot know whether it should exist at all.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch on open, and re-read on every re-open so a stale panel can't mislead.
  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (!next || busy !== null) return;
    setBusy("load");
    void refresh().finally(() => {
      if (aliveRef.current) setBusy(null);
    });
  }, [open, busy, refresh]);

  /**
   * Run one of the three long operations, then re-read health so the lamp reflects the
   * check the server just performed (each of these endpoints ends in a real probe).
   */
  const run = useCallback(
    async (op: Exclude<Op, "load">, call: () => Promise<CookieResult>): Promise<void> => {
      if (busy !== null) return;
      setBusy(op);
      setResult(null);
      try {
        const r = await call();
        if (!aliveRef.current) return;
        setResult({ op, ok: r.ok, reason: r.reason, warning: warningOf(r) });
        // Nothing left to keep: the jar lives on the server now, and a pasted session is
        // not something this UI should go on holding.
        if (r.ok && op === "save") setText("");
      } catch (e) {
        if (!aliveRef.current) return;
        setResult({
          op,
          ok: false,
          reason: requestMessage(e, "The request failed."),
          // A transport failure carries no server prose; only the server sets warnings.
          warning: null,
        });
      } finally {
        await refresh();
        if (aliveRef.current) setBusy(null);
      }
    },
    [busy, refresh],
  );

  const panelId = "cookie-console-panel";
  // health + its derived presentation, or null while we have never read it.
  const view = health === null ? null : { h: health, ...readState(health) };
  // A closed panel still flags trouble — but only once we have actually looked.
  const flagged = !open && view !== null && view.bad;
  const rule = { border: 0, borderTop: "1px solid var(--color-line)" } as const;

  // Until the probe answers we do not know whether this console exists here — render nothing
  // rather than flashing a control that may be about to disappear.
  if (gate === "unknown") return null;

  // Not configured on this server: render NOTHING. An operator who never set
  // COOKIE_ADMIN_PASSWORD should not see a console advertising itself to every guild member.
  if (gate === "disabled") return null;

  // Configured but this tab has not unlocked it. Show only the prompt — no health, no buttons,
  // nothing about the account. A Discord login only proves you share a server with the bot; it
  // does not get you the operator's Google session.
  if (gate === "locked") {
    // And until the operator asks for it by URL, show not even the prompt. Someone who came to
    // queue a song has no use for an admin card, and a password box under the playlists reads
    // like something is broken. THE HASH IS DISCOVERABILITY, NOT A SECURITY BOUNDARY — the
    // password is the boundary, and it is enforced by the server, not by this line. Note the
    // gate === "open" path below ignores the hash entirely: that tab has already authenticated,
    // so hiding its console on a hash it no longer has would just lose the operator their panel.
    if (hash !== REVEAL_HASH) return null;
    return (
      <div className="mt-4">
        <form
          className="card p-4 flex flex-wrap items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const next = adminDraft.trim();
            if (!next) return;
            try {
              sessionStorage.setItem(ADMIN_KEY, next);
            } catch {
              /* private mode — keep it in memory for this tab only */
            }
            setAdminDraft("");
            setAdmin(next); // refresh() re-runs on the new value and flips the gate
          }}
        >
          <span className="eyebrow">Cookie console</span>
          <input
            type="password"
            className="flex-1"
            style={{ minWidth: "12rem" }}
            placeholder="console password"
            aria-label="Cookie console password"
            autoComplete="off"
            value={adminDraft}
            onChange={(e) => setAdminDraft(e.target.value)}
          />
          <button type="submit" className="pill" disabled={!adminDraft.trim()}>
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        className="pill pill-ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <span aria-hidden>🍪</span> {open ? "Hide cookie console" : "Cookie console"}
        {flagged && (
          <span
            className="font-mono text-xs"
            style={{ color: LAMP_FAULT }}
            title="YouTube is refusing the current cookies"
          >
            <span aria-hidden>● </span>needs attention
          </span>
        )}
      </button>

      {open && (
        <div id={panelId} className="card reveal mt-3 p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-3">
            <span className="eyebrow">YouTube session</span>
            <span className="eyebrow" style={{ color: "var(--color-ink-faint)" }}>
              yt-dlp cookie jar
            </span>
          </div>

          {/* ---- Health ------------------------------------------------------- */}
          <div
            className="mt-4 p-4"
            style={{
              background: "var(--color-sunken)",
              border: "1px solid var(--color-line)",
              // A lit amber rule is the fault lamp on a deck whose red already means "on air".
              borderLeft: `2px solid ${view?.bad ? LAMP_FAULT : "var(--color-line)"}`,
              borderRadius: "var(--radius-sm)",
              boxShadow: "var(--shadow-inset)",
            }}
          >
            {view === null ? (
              <p
                className="flex items-center gap-2 font-mono text-sm"
                style={{ color: "var(--color-ink-faint)" }}
              >
                {loadError === null ? (
                  <>
                    <span className="spinner" aria-hidden /> Reading cookie status…
                  </>
                ) : (
                  loadError
                )}
              </p>
            ) : (
              <div role="status" aria-live="polite">
                <div className="flex flex-wrap items-center gap-3">
                  {/* The lamp: a lit dot plus the word, so the state never rides on colour alone. */}
                  <span
                    className="font-mono text-xs inline-flex items-center gap-2"
                    style={{
                      color: view.live ? TEXT_LIVE : view.bad ? LAMP_FAULT : "var(--color-ink-dim)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: "0.5rem",
                        height: "0.5rem",
                        borderRadius: "999px",
                        background: view.live
                          ? LAMP_LIVE
                          : view.bad
                            ? LAMP_FAULT
                            : "var(--color-ember-deep)",
                        boxShadow: view.live
                          ? "0 0 10px -1px var(--color-ember)"
                          : view.bad
                            ? "0 0 10px -1px var(--color-gold)"
                            : "none",
                      }}
                    />
                    {view.tally}
                  </span>
                  <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                    {SOURCE_LABEL[view.h.source]}
                  </span>
                </div>
                <p className="font-display text-2xl mt-3" style={{ color: "var(--color-ink)" }}>
                  {view.headline}
                </p>
                <p className="mt-1.5 text-sm" style={{ color: "var(--color-ink-dim)" }}>
                  {view.detail}
                </p>
                <p className="mt-3 font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                  <span title={stamp(view.h.updatedAt)}>Updated {ago(view.h.updatedAt)}</span>
                  {" · "}
                  <span title={stamp(view.h.lastCheck?.at ?? null)}>
                    Checked {ago(view.h.lastCheck?.at ?? null)}
                  </span>
                </p>
              </div>
            )}
          </div>

          {/* ---- The last action's outcome (status only — never a cookie) ------ */}
          {result && (
            <p
              role="status"
              aria-live="polite"
              className="mt-4 text-sm font-mono"
              style={{ color: result.ok ? TEXT_LIVE : LAMP_FAULT }}
            >
              {result.ok
                ? result.op === "test"
                  ? "YouTube accepted the current cookies."
                  : result.op === "save"
                    ? "Saved and applied — YouTube accepted them. No restart needed."
                    : "Imported from the browser profile and applied — YouTube accepted them."
                : `${
                    result.op === "test"
                      ? "Test failed"
                      : result.op === "save"
                        ? "Not applied"
                        : "Import failed"
                  } — ${result.reason ?? "no reason given"}.`}
            </p>
          )}

          {/* ---- A caveat that rides ALONGSIDE the line above ------------------
              The server sets `warning` on operations that WORKED but left something the
              operator has to hear: a jar saved with no sign-in cookie in it, or an import that
              silently dropped cookies it could not decrypt. It gets a railed well rather than
              another bare line, so it reads as a note attached to the result instead of
              competing with it. */}
          {result?.warning && (
            <div
              role="status"
              aria-live="polite"
              className="mt-3 px-3 py-2.5"
              style={{
                background: "var(--color-sunken)",
                border: "1px solid var(--color-line)",
                borderLeft: `3px solid ${LAMP_FAULT}`,
                borderRadius: "var(--radius-sm)",
              }}
            >
              <span className="eyebrow" style={{ color: LAMP_FAULT }}>
                <span aria-hidden style={{ marginRight: "0.35rem" }}>
                  &#9888;
                </span>
                Heads up
              </span>
              <p className="mt-2 font-mono text-xs" style={{ color: "var(--color-ink-dim)" }}>
                {result.warning}
              </p>
            </div>
          )}

          {/* Honest pending copy: a probe is a real download attempt, not a ping. */}
          {(busy === "test" || busy === "save" || busy === "import") && (
            <p
              role="status"
              aria-live="polite"
              className="mt-4 flex items-center gap-2 font-mono text-xs"
              style={{ color: "var(--color-ink-faint)" }}
            >
              <span className="spinner" aria-hidden />
              {busy === "import"
                ? "Reading the browser profile, then extracting for real — this can take a minute."
                : "Running a real extraction against YouTube — this can take a minute."}
            </p>
          )}

          <div className="mt-4">
            <button
              type="button"
              className="pill"
              disabled={busy !== null}
              aria-busy={busy === "test"}
              onClick={() => void run("test", () => api.cookiesTest(admin))}
            >
              {busy === "test" ? (
                <>
                  <span className="spinner" aria-hidden /> Testing…
                </>
              ) : (
                "Test now"
              )}
            </button>
          </div>

          <hr className="mt-6" style={rule} />

          {/* ---- Paste --------------------------------------------------------- */}
          <div className="mt-5">
            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Paste new cookies</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                spellCheck={false}
                autoComplete="off"
                aria-label="Paste new cookies"
                placeholder="Paste an exported cookies.txt, or one Cookie: … header line"
                className="w-full font-mono text-xs"
                style={{ resize: "vertical", minHeight: "7rem" }}
              />
            </label>
            <p className="mt-2 text-xs" style={{ color: "var(--color-ink-faint)" }}>
              Both forms work: a full <span className="font-mono">cookies.txt</span> export
              (Netscape format), or a single-line browser <span className="font-mono">Cookie:</span>{" "}
              header. What you paste is written to the jar on the server and applied to the running
              bot — it is never read back or displayed here.
            </p>
            <button
              type="button"
              className="pill pill-primary mt-4"
              disabled={busy !== null || text.trim() === ""}
              aria-busy={busy === "save"}
              onClick={() => void run("save", () => api.cookiesSave(admin, text))}
            >
              {busy === "save" ? (
                <>
                  <span className="spinner" aria-hidden /> Applying…
                </>
              ) : (
                "Save & apply"
              )}
            </button>
          </div>

          {/* ---- Import from the sidecar (only when the profile is really there) --- */}
          {view?.h.browserProfileAvailable && (
            <>
              <hr className="mt-6" style={rule} />
              <div className="mt-5">
                <span className="eyebrow">Browser profile</span>
                <p className="mt-2 text-xs" style={{ color: "var(--color-ink-faint)" }}>
                  Copies the YouTube cookies out of the signed-in browser sidecar&rsquo;s profile
                  and applies them here — sign in over there first, then press this.
                </p>
                <button
                  type="button"
                  className="pill mt-4"
                  disabled={busy !== null}
                  aria-busy={busy === "import"}
                  onClick={() => void run("import", () => api.cookiesImport(admin))}
                >
                  {busy === "import" ? (
                    <>
                      <span className="spinner" aria-hidden /> Importing…
                    </>
                  ) : (
                    "Import from browser"
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
