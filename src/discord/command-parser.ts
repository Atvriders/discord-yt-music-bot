export type Command =
  | { kind: "play"; input: string }
  | { kind: "skip" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "queue" }
  | { kind: "np" }
  | { kind: "history" }
  | { kind: "help" }
  | { kind: "remove"; index: number }
  | { kind: "volume"; percent: number }
  | { kind: "channel"; mode: "set" | "off" }
  | { kind: "none" };

const CONTROL = new Set(["skip", "pause", "resume", "stop", "queue", "np", "history", "help"]);

export function parseCommand(content: string, prefix = "?"): Command {
  if (!content.startsWith(prefix)) return { kind: "none" };
  const body = content.slice(prefix.length).trim();
  if (!body) return { kind: "help" };

  const spaceIdx = body.indexOf(" ");
  const keyword = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();

  if (CONTROL.has(keyword))
    return {
      kind: keyword as Exclude<Command["kind"], "play" | "remove" | "volume" | "channel" | "none">,
    };
  if (keyword === "remove") {
    const n = Number(rest);
    return Number.isInteger(n) && n >= 1 ? { kind: "remove", index: n } : { kind: "help" };
  }
  if (keyword === "volume" || keyword === "vol") {
    // `?volume <0-200>`. A trailing `%` is tolerated. Missing/invalid → help.
    const arg = rest.replace(/%$/, "").trim();
    const n = Number(arg);
    return arg !== "" && Number.isFinite(n) && n >= 0 && n <= 200
      ? { kind: "volume", percent: Math.round(n) }
      : { kind: "help" };
  }
  if (keyword === "channel") {
    // `?channel` (or any stray arg) restricts the bot to THIS channel; `off`/`none`/`clear`
    // removes the restriction. The actual channel id comes from the message at handle time.
    const arg = rest.toLowerCase();
    return arg === "off" || arg === "none" || arg === "clear"
      ? { kind: "channel", mode: "off" }
      : { kind: "channel", mode: "set" };
  }
  if (keyword === "play") return rest ? { kind: "play", input: rest } : { kind: "help" };
  // bare `?<url|query>` → play the whole body
  return { kind: "play", input: body };
}
