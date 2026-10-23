import { parseArgs } from "node:util";
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, readInterval } from "../config/interval.js";
import type { ConfigAction } from "../commands/config.js";
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
  run -p PROFILE         poll gh-pr-tools and send notifications

options of run:
  -p, --profile NAME        gh-pr-tools profile to use (required)
      --dry-run             print the messages instead of sending them
      --once                run a single poll and exit
      --interval 1m         time between polls: 90s, 5m, 1h (1m to 12h; overrides POLL_INTERVAL)
      --commands LIST       comma-separated: mine,todo (default: both)
      --pr-tools PATH       run this gh-pr-tools entry script instead of \`gh pr-tools\`
  -v, --version             print the version
  -h, --help                show this help`;

export interface RunConfig {
  profile: string;
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

export function parseCommands(text: string): Command[] {
  const commands: Command[] = [];
  for (const part of text.split(",").map((p) => p.trim())) {
    if (part !== "mine" && part !== "todo") throw new UsageError(`unknown command '${part}' in --commands (use mine, todo)`);
    if (!commands.includes(part)) commands.push(part);
  }
  return commands;
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

export function parseCli(argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        profile: { type: "string", short: "p" },
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
  if (positionals.length > 1) throw new UsageError(`unexpected argument '${positionals[1]}'`);
  if (values.yes && positionals[0] !== "reset") throw new UsageError("--yes is only for reset");
  if (positionals[0] === "reset") return { kind: "reset", yes: values.yes ?? false };
  if (positionals[0] === "init" || positionals[0] === "send-test" || positionals[0] === "status")
    return { kind: positionals[0] };
  if (positionals[0] !== "run") throw new UsageError(`unknown command '${positionals[0]}'`);
  if (!values.profile) throw new UsageError("--profile is required");

  const config: RunConfig = {
    profile: values.profile,
    dryRun: values["dry-run"] ?? false,
    once: values.once ?? false,
    commands: parseCommands(values.commands ?? "mine,todo"),
  };
  if (values.interval !== undefined) config.intervalMs = parseInterval(values.interval);
  if (values["pr-tools"]) config.prToolsPath = values["pr-tools"];
  return { kind: "run", config };
}
