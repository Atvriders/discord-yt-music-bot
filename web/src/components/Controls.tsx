import type { ControlAction } from "../lib/api.js";

const Icon = { skip: "⏭", pause: "⏸", resume: "▶", stop: "■" } as const;

export function Controls({ onAction, paused, disabled }: {
  onAction: (a: ControlAction) => void; paused: boolean; disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button className="pill pill-primary" disabled={disabled} aria-label={paused ? "Resume" : "Pause"}
        onClick={() => onAction(paused ? "resume" : "pause")}>
        <span aria-hidden>{paused ? Icon.resume : Icon.pause}</span> {paused ? "Resume" : "Pause"}
      </button>
      <button className="pill" disabled={disabled} aria-label="Skip" onClick={() => onAction("skip")}>
        <span aria-hidden>{Icon.skip}</span> Skip
      </button>
      <button className="pill pill-ghost" disabled={disabled} aria-label="Stop" onClick={() => onAction("stop")}>
        <span aria-hidden>{Icon.stop}</span> Stop
      </button>
    </div>
  );
}
