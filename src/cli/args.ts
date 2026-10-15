import { parseArgs } from "node:util";
import type { Command } from "../runner/types.js";

export class UsageError extends Error {}

export const USAGE = `usage: pr-tools-notifier <command>

commands:
  init                   set up your own Telegram bot (once)
  send-test              send sample notifications to check the setup
  run -p PROFILE         poll gh-pr-tools and send notifications

options of run:
  -p, --profile NAME     gh-pr-tools profile to use (required)
      --dry-run          print the messages instead of sending them
      --once             run a single poll and exit
      --interval 1m      time between polls: 90s, 5m, 1h (default and minimum: 1m)
      --commands LIST    comma-separated: mine,todo (default: both)
      --pr-tools PATH    run this gh-pr-tools entry script instead of \`gh pr-tools\`
  -h, --help             show this help`;

export interface RunConfig {
  profile: string;
  dryRun: boolean;
  once: boolean;
  intervalMs: number;
  commands: Command[];
  prToolsPath?: string;
}

export type Parsed = { kind: "help" } | { kind: "init" } | { kind: "send-test" } | { kind: "run"; config: RunConfig };

const MIN_INTERVAL_MS = 60_000;
const UNITS: Record<string, number> = { "": 1_000, s: 1_000, m: 60_000, h: 3_600_000 };

export function parseInterval(text: string): number {
  const match = /^(\d+)([smh]?)$/.exec(text.trim());
  if (!match) throw new UsageError(`invalid --interval '${text}' (use e.g. 90s, 5m or 1h)`);
  const ms = Number(match[1]) * UNITS[match[2]!]!;
  if (ms < MIN_INTERVAL_MS) throw new UsageError("--interval must be at least 1m");
  return ms;
}

export function parseCommands(text: string): Command[] {
  const commands: Command[] = [];
  for (const part of text.split(",").map((p) => p.trim())) {
    if (part !== "mine" && part !== "todo") throw new UsageError(`unknown command '${part}' in --commands (use mine, todo)`);
    if (!commands.includes(part)) commands.push(part);
  }
  return commands;
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
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  if (values.help || positionals.length === 0) return { kind: "help" };
  if (positionals.length > 1) throw new UsageError(`unexpected argument '${positionals[1]}'`);
  if (positionals[0] === "init" || positionals[0] === "send-test") return { kind: positionals[0] };
  if (positionals[0] !== "run") throw new UsageError(`unknown command '${positionals[0]}'`);
  if (!values.profile) throw new UsageError("--profile is required");

  const config: RunConfig = {
    profile: values.profile,
    dryRun: values["dry-run"] ?? false,
    once: values.once ?? false,
    intervalMs: parseInterval(values.interval ?? "1m"),
    commands: parseCommands(values.commands ?? "mine,todo"),
  };
  if (values["pr-tools"]) config.prToolsPath = values["pr-tools"];
  return { kind: "run", config };
}
