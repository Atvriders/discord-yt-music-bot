export type Command =
  | { kind: "play"; input: string }
  | { kind: "skip" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stop" }
  | { kind: "queue" }
  | { kind: "np" }
  | { kind: "help" }
  | { kind: "remove"; index: number }
  | { kind: "none" };

const CONTROL = new Set(["skip", "pause", "resume", "stop", "queue", "np", "help"]);

export function parseCommand(content: string, prefix = "?"): Command {
  if (!content.startsWith(prefix)) return { kind: "none" };
  const body = content.slice(prefix.length).trim();
  if (!body) return { kind: "help" };

  const spaceIdx = body.indexOf(" ");
  const keyword = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();

  if (CONTROL.has(keyword))
    return { kind: keyword as Exclude<Command["kind"], "play" | "remove" | "none"> };
  if (keyword === "remove") {
    const n = Number(rest);
    return Number.isInteger(n) && n >= 1 ? { kind: "remove", index: n } : { kind: "help" };
  }
  if (keyword === "play") return rest ? { kind: "play", input: rest } : { kind: "help" };
  // bare `?<url|query>` → play the whole body
  return { kind: "play", input: body };
}
