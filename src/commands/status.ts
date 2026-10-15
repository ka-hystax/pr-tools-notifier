import { join } from "node:path";
import { ConfigError, type ConfigStore } from "../config/config.js";
import { describeStates } from "../state/store.js";
import type { BotCheck } from "./sinks.js";

export interface StatusDeps {
  config: ConfigStore;
  stateDir: string;
  check: (token: string) => Promise<BotCheck>;
  activeLocks: () => string[];
  out: (line: string) => void;
  now?: () => Date;
  timeZone?: string;
}

function age(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

// Resolves to whether the bot is set up and accepted by Telegram.
export async function runStatus({
  config,
  stateDir,
  check,
  activeLocks,
  out,
  now = () => new Date(),
  timeZone,
}: StatusDeps): Promise<boolean> {
  out(`Config:  ${config.dir}`);

  let healthy = false;
  try {
    const saved = config.load();
    if (!saved) {
      out("Bot:     not set up, run `pr-tools-notifier init`");
    } else {
      const result = await check(saved.token);
      const verdict =
        result.status === "ok"
          ? "token accepted"
          : result.status === "rejected"
            ? result.problem
            : `could not check (${result.problem})`;
      out(`Bot:     @${saved.botUsername}, chat ${saved.chatId}: ${verdict}`);
      healthy = result.status !== "rejected";
    }
  } catch (err) {
    out(`Bot:     ${err instanceof ConfigError ? err.message : String(err)}`);
  }

  const states = describeStates(stateDir);
  if (states.length === 0) {
    out("State:   none yet, `pr-tools-notifier run -p PROFILE` creates it");
    return healthy;
  }
  out("State:");
  const running = new Set(activeLocks());
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23",
  });
  for (const info of states) {
    const saved = info.savedAt === null ? null : new Date(info.savedAt);
    const detail =
      saved === null || info.prs === null
        ? "unreadable by this version, the next run starts a fresh baseline"
        : `${info.prs} PRs, last poll ${format.format(saved)} (${age(saved, now())})`;
    const live = running.has(`${join(stateDir, `${info.profile}-${info.command}.json`)}.lock`) ? ", running" : "";
    out(`  ${info.profile} ${info.command}: ${detail}${live}`);
  }
  return healthy;
}
