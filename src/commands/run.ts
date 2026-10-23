import { join } from "node:path";
import type { RunConfig } from "../cli/args.js";
import { createLogger } from "../cli/logger.js";
import type { ConfigStore } from "../config/config.js";
import { DEFAULT_INTERVAL_MS } from "../config/interval.js";
import { stateDir } from "../config/paths.js";
import type { Settings } from "../config/settings.js";
import { DryRunSink } from "../runner/dryRun.js";
import { runLoop } from "../runner/loop.js";
import { FailureMonitor } from "../runner/monitor.js";
import { runTick } from "../runner/tick.js";
import { ghSource } from "../sources/gh.js";
import { LockError, type Lock } from "../state/lock.js";
import { StateStore } from "../state/store.js";
import { checkBot, NOT_CONFIGURED, telegramBot } from "./sinks.js";

// The flag wins over the setting, which wins over the default.
export function pollInterval(options: Pick<RunConfig, "intervalMs">, settings: Settings): number {
  return options.intervalMs ?? settings.intervalMs ?? DEFAULT_INTERVAL_MS;
}

// Resolves to the process exit code.
export async function runCommand(options: RunConfig, config: ConfigStore, settings: Settings = {}): Promise<number> {
  const { profile, dryRun, once, commands, prToolsPath } = options;
  const intervalMs = pollInterval(options, settings);
  const mergeStatuses = commands.includes("mine") ? settings.mergeStatuses : undefined;
  const controller = new AbortController();
  const bot = dryRun ? null : telegramBot(config, controller.signal);
  if (!dryRun && !bot) {
    console.error(NOT_CONFIGURED);
    return 1;
  }
  const check = bot ? await checkBot(bot.api) : null;
  if (check?.status === "rejected") {
    console.error(`pr-tools-notifier: ${check.problem}`);
    return 1;
  }
  const sink = bot?.sink ?? new DryRunSink();

  const log = createLogger();
  const dir = dryRun ? join(stateDir(), "dry-run") : stateDir();
  const stores = { mine: new StateStore(dir, profile, "mine"), todo: new StateStore(dir, profile, "todo") };

  const locks: Lock[] = [];
  try {
    for (const command of commands) locks.push(stores[command].lock());
  } catch (err) {
    for (const lock of locks) lock.release();
    if (err instanceof LockError) {
      log.error(err.message);
      return 1;
    }
    throw err;
  }

  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const source = ghSource({
      profile,
      signal: controller.signal,
      onWarning: (line) => log.warn(line),
      ...(prToolsPath ? { prToolsPath } : {}),
      ...(mergeStatuses ? { jiraRequired: true } : {}),
    });
    const mode = dryRun ? "dry run" : "sending to Telegram";
    log.info(
      `profile ${profile}: ${commands.join(" + ")}${once ? ", one poll" : `, every ${Math.round(intervalMs / 1000)}s`}, ${mode}`
    );
    if (mergeStatuses)
      log.info(`"Time to merge" waits for the Jira status: ${mergeStatuses.join(", ")} (MERGE_STATUS in settings)`);
    const ok = await runLoop({
      tick: () => runTick({ commands, source, stores, sink, log, ...(mergeStatuses ? { mergeStatuses } : {}) }),
      sink,
      monitor: new FailureMonitor(),
      log,
      intervalMs,
      once,
      signal: controller.signal,
    });
    return ok ? 0 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    for (const lock of locks) lock.release();
  }
}
