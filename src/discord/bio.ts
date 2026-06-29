/**
 * Builds the bot's Discord "About Me" text (the application description) from the
 * ACTUAL configured values, so it can never drift from the real prefix/URL.
 *
 * Kept as a pure, side-effect-free function so it's trivially unit-testable; the
 * ready handler in bot.ts feeds it the live config and pushes the result to Discord.
 */

/** Discord's hard limit for an application description. */
export const BIO_MAX_LENGTH = 400;

const TAGLINE = "🎵 Plays the exact YouTube audio you give it — never a mirror.";

/** A single command example: `name` + optional `args` (e.g. `play` + `<url|search>`). */
export interface BioCommand {
  name: string;
  args?: string;
}

/**
 * The canonical command set, in the order they should appear in the bio. Mirrors the
 * commands the parser/handlers actually support (see command-parser.ts / handlers.ts).
 */
export const DEFAULT_BIO_COMMANDS: readonly BioCommand[] = [
  { name: "play", args: "<url|search>" },
  { name: "skip" },
  { name: "pause" },
  { name: "resume" },
  { name: "stop" },
  { name: "queue" },
  { name: "np" },
  { name: "remove", args: "<n>" },
  { name: "help" },
];

export interface BuildBotBioOptions {
  /** The configured command prefix (BotConfig.commandPrefix), e.g. "?". */
  prefix: string;
  /** The public web-panel base URL (WebConfig.publicBaseUrl). Optional. */
  baseUrl?: string;
  /** Override the command list (defaults to DEFAULT_BIO_COMMANDS). */
  commands?: readonly BioCommand[];
}

function renderCommand(prefix: string, cmd: BioCommand): string {
  return cmd.args ? `${prefix}${cmd.name} ${cmd.args}` : `${prefix}${cmd.name}`;
}

/**
 * Build the bio string. Shape:
 *   🎵 <tagline> Prefix: <p> · Commands: <p>play <url|search>, … · Panel: <url>
 *
 * - The command examples are rendered with the configured prefix, so a non-`?`
 *   prefix renders correctly.
 * - The "Panel:" segment is omitted entirely when no baseUrl is provided.
 * - Never exceeds BIO_MAX_LENGTH: if the assembled string would, it's truncated
 *   gracefully (with an ellipsis) so Discord's edit call can't be rejected.
 */
export function buildBotBio(opts: BuildBotBioOptions): string {
  const { prefix, baseUrl } = opts;
  const commands = opts.commands ?? DEFAULT_BIO_COMMANDS;

  const commandList = commands.map((c) => renderCommand(prefix, c)).join(", ");

  // The tagline already ends in a period, so it's separated from the rest by a plain
  // space; the remaining fields are joined by the " · " separator.
  const fields = [`Prefix: ${prefix}`, `Commands: ${commandList}`];
  if (baseUrl) fields.push(`Panel: ${baseUrl}`);

  const bio = `${TAGLINE} ${fields.join(" · ")}`;
  if (bio.length <= BIO_MAX_LENGTH) return bio;

  // Graceful truncation: keep the start (tagline + prefix + as much of the command
  // list as fits) and append an ellipsis, so we never overrun Discord's limit.
  const ELLIPSIS = "…";
  return bio.slice(0, BIO_MAX_LENGTH - ELLIPSIS.length) + ELLIPSIS;
}
