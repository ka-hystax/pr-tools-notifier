import { parseArgs } from "node:util";
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, readInterval } from "../config/interval.js";
import type { ConfigAction } from "../commands/config.js";
import type { TrackAction } from "../commands/track.js";
import type { Command } from "../runner/types.js";

export class UsageError extends Error {}

export const USAGE = `usage: pr-tools-notifier <command>

commands:
  init                   set up your own Telegram bot (once)
  status                 show the bot, its check against Telegram and the saved state
  config                 show the settings (merge statuses, poll interval)
  config set KEY VALUE   change a setting; config unset KEY removes it
  reset [-y]             remove the saved bot token, settings and state (asks first; -y skips the question)
  send-test              send sample notifications to check the setup
  run [-p PROFILE]...    poll gh-pr-tools, send notifications and answer the bot's commands
  track [-p PROFILE]     show the PRs and Jira tickets you follow
  track add REF...       follow PRs (1281, a PR link) or Jira tickets (PRJ-1824, a Jira link)
  track rm REF...        stop following them

options of run:
  -p, --profile NAME[:LIST] gh-pr-tools profile to poll, repeat for several (default: all of them);
                            LIST polls only those commands for it, e.g. -p ops:track
      --dry-run             print the messages instead of sending them
      --once                run a single poll and exit
      --interval 1m         time between polls: 90s, 5m, 1h (1m to 12h; overrides POLL_INTERVAL)
      --commands LIST       comma-separated: mine,todo,track (default: all; track polls only a non-empty list)
      --pr-tools PATH       run this gh-pr-tools entry script instead of \`gh pr-tools\`
  -v, --version             print the version
  -h, --help                show this help`;

// A profile to poll, with its own commands or (absent) those of --commands.
export interface ProfileSpec {
  name: string;
  commands?: Command[];
}

export interface RunConfig {
  profiles: ProfileSpec[]; // empty: every gh-pr-tools profile
  dryRun: boolean;
  once: boolean;
  intervalMs?: number; // absent: the setting POLL_INTERVAL, or one minute
  commands: Command[];
  prToolsPath?: string;
}

export type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init" }
  | { kind: "send-test" }
  | { kind: "status" }
  | { kind: "reset"; yes: boolean }
  | { kind: "config"; action: ConfigAction }
  | { kind: "track"; action: TrackAction; profile?: string; prToolsPath?: string }
  | { kind: "run"; config: RunConfig };

export function parseInterval(text: string): number {
  const result = readInterval(text);
  if ("ms" in result) return result.ms;
  if (result.error === "format") throw new UsageError(`invalid --interval '${text}' (use e.g. 90s, 5m or 1h)`);
  throw new UsageError(
    result.error === "min"
      ? `--interval must be at least ${MIN_INTERVAL_MS / 60_000}m`
      : `--interval must be at most ${MAX_INTERVAL_MS / 3_600_000}h`
  );
}

export function parseCommands(text: string, where = "--commands"): Command[] {
  const commands: Command[] = [];
  for (const part of text.split(",").map((p) => p.trim())) {
    if (part !== "mine" && part !== "todo" && part !== "track") {
      throw new UsageError(`unknown command '${part}' in ${where} (use mine, todo, track)`);
    }
    if (!commands.includes(part)) commands.push(part);
  }
  return commands;
}

// "work" or "work:mine,track"; profile names cannot hold a colon.
export function parseProfiles(values: string[]): ProfileSpec[] {
  const specs: ProfileSpec[] = [];
  for (const value of values) {
    const colon = value.indexOf(":");
    const name = (colon < 0 ? value : value.slice(0, colon)).trim();
    if (name === "") throw new UsageError(`no profile name in -p '${value}'`);
    if (specs.some((s) => s.name === name)) throw new UsageError(`profile '${name}' is named twice`);
    specs.push(colon < 0 ? { name } : { name, commands: parseCommands(value.slice(colon + 1), `-p ${value}`) });
  }
  return specs;
}

function parseConfigAction(args: string[]): ConfigAction {
  const [action, key, value, ...extra] = args;
  if (action === undefined) return { type: "show" };
  if (action === "set") {
    if (key === undefined || value === undefined)
      throw new UsageError("usage: config set KEY VALUE (quote a value with spaces)");
    if (extra.length > 0) throw new UsageError(`unexpected argument '${extra[0]}' (quote a value with spaces)`);
    return { type: "set", key, value };
  }
  if (action === "unset") {
    if (key === undefined || value !== undefined) throw new UsageError("usage: config unset KEY");
    return { type: "unset", key };
  }
  throw new UsageError(`unknown config action '${action}' (use set or unset)`);
}

function parseTrackAction(args: string[]): TrackAction {
  const [action, ...refs] = args;
  if (action === undefined) return { type: "show" };
  if (action === "add" || action === "rm") {
    if (refs.length === 0) throw new UsageError(`usage: track ${action} REF... (1281, a PR link, PRJ-1824 or a Jira link)`);
    return { type: action, refs };
  }
  throw new UsageError(`unknown track action '${action}' (use add or rm)`);
}

export function parseCli(argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        profile: { type: "string", short: "p", multiple: true },
        "dry-run": { type: "boolean" },
        once: { type: "boolean" },
        interval: { type: "string" },
        commands: { type: "string" },
        "pr-tools": { type: "string" },
        yes: { type: "boolean", short: "y" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  if (values.version) return { kind: "version" };
  if (values.help || positionals.length === 0) return { kind: "help" };
  if (positionals[0] === "config") return { kind: "config", action: parseConfigAction(positionals.slice(1)) };
  if (positionals[0] === "track") {
    if (values.yes) throw new UsageError("--yes is only for reset");
    const track: Extract<Parsed, { kind: "track" }> = { kind: "track", action: parseTrackAction(positionals.slice(1)) };
    if ((values.profile?.length ?? 0) > 1) throw new UsageError("track takes one -p PROFILE");
    if (values.profile?.[0]) track.profile = values.profile[0];
    if (values["pr-tools"]) track.prToolsPath = values["pr-tools"];
    return track;
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument '${positionals[1]}'`);
  if (values.yes && positionals[0] !== "reset") throw new UsageError("--yes is only for reset");
  if (positionals[0] === "reset") return { kind: "reset", yes: values.yes ?? false };
  if (positionals[0] === "init" || positionals[0] === "send-test" || positionals[0] === "status")
    return { kind: positionals[0] };
  if (positionals[0] !== "run") throw new UsageError(`unknown command '${positionals[0]}'`);

  const config: RunConfig = {
    profiles: parseProfiles(values.profile ?? []),
    dryRun: values["dry-run"] ?? false,
    once: values.once ?? false,
    commands: parseCommands(values.commands ?? "mine,todo,track"),
  };
  if (values.interval !== undefined) config.intervalMs = parseInterval(values.interval);
  if (values["pr-tools"]) config.prToolsPath = values["pr-tools"];
  return { kind: "run", config };
}
