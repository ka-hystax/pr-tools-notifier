import { join } from "node:path";
import { Bot } from "../bot/bot.js";
import { BotStateStore } from "../bot/state.js";
import type { RunConfig } from "../cli/args.js";
import { createLogger } from "../cli/logger.js";
import type { ConfigStore } from "../config/config.js";
import { DEFAULT_INTERVAL_MS, formatInterval } from "../config/interval.js";
import { stateDir } from "../config/paths.js";
import type { Settings, SettingsStore } from "../config/settings.js";
import { DryRunSink } from "../runner/dryRun.js";
import { runLoop } from "../runner/loop.js";
import { FailureMonitor } from "../runner/monitor.js";
import { runTick } from "../runner/tick.js";
import { errorMessage, type Logger } from "../runner/types.js";
import { ghSource } from "../sources/gh.js";
import { ProfileError, resolveProfile } from "../sources/profiles.js";
import { acquireLock, LockError, type Lock } from "../state/lock.js";
import { StateStore } from "../state/store.js";
import { ensurePrivateDir } from "../utils/fs.js";
import { checkBot, NOT_CONFIGURED, telegramBot } from "./sinks.js";

// The flag wins over the setting, which wins over the default.
export function pollInterval(options: Pick<RunConfig, "intervalMs">, settings: Settings): number {
  return options.intervalMs ?? settings.intervalMs ?? DEFAULT_INTERVAL_MS;
}

function describeSettings({ mergeStatuses, intervalMs }: Settings): string {
  const merge = mergeStatuses ? `Jira merge status ${mergeStatuses.join(", ")}` : "no Jira merge status";
  return `poll every ${formatInterval(intervalMs ?? DEFAULT_INTERVAL_MS)}, ${merge}`;
}

// Re-read on every use, so `config set` and the bot's /settings apply without a restart.
// A file broken by hand keeps the last good settings, with one warning per mistake.
export function liveSettings(store: SettingsStore | undefined, log: Logger): () => Settings {
  let last: Settings = {};
  let shown = "";
  let broken = "";
  try {
    last = store?.load() ?? {};
    shown = JSON.stringify(last);
  } catch {
    // main refuses to start with a broken file, so this only happens in a race with an edit
  }
  return () => {
    if (!store) return last;
    try {
      const next = store.load();
      broken = "";
      if (JSON.stringify(next) !== shown) {
        shown = JSON.stringify(next);
        log.info(`settings changed: ${describeSettings(next)}`);
      }
      last = next;
    } catch (err) {
      const message = errorMessage(err);
      if (message !== broken) log.warn(`${message}; keeping the previous settings`);
      broken = message;
    }
    return last;
  };
}

// Resolves to the process exit code.
export async function runCommand(options: RunConfig, config: ConfigStore, settingsStore?: SettingsStore): Promise<number> {
  const { dryRun, once, commands, prToolsPath } = options;
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

  let profile: string;
  try {
    profile = await resolveProfile({
      ...(options.profile ? { profile: options.profile } : {}),
      ...(prToolsPath ? { prToolsPath } : {}),
    });
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    console.error(`pr-tools-notifier: ${err.message}`);
    return 1;
  }

  const log = createLogger();
  const settings = liveSettings(settingsStore, log);
  const mergeStatuses = () => (commands.includes("mine") ? settings().mergeStatuses : undefined);
  const intervalMs = () => pollInterval(options, settings());
  const dir = dryRun ? join(stateDir(), "dry-run") : stateDir();
  const stores = { mine: new StateStore(dir, profile, "mine"), todo: new StateStore(dir, profile, "todo") };

  const locks: Lock[] = [];
  let listen = !dryRun && !once;
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

  // Only one process may read the bot's messages; the others still send notifications.
  if (bot && !once) {
    try {
      ensurePrivateDir(dir);
      locks.push(acquireLock(join(dir, "bot.lock")));
    } catch (err) {
      if (!(err instanceof LockError)) {
        for (const lock of locks) lock.release();
        throw err;
      }
      log.warn(`another run already answers commands (${err.message}); this one only sends notifications`);
      listen = false;
    }
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
      jiraRequired: () => mergeStatuses() !== undefined,
    });
    const mode = dryRun ? "dry run" : "sending to Telegram";
    log.info(
      `profile ${profile}${options.profile ? "" : " (the only one)"}: ${commands.join(" + ")}${once ? ", one poll" : `, every ${formatInterval(intervalMs())}`}, ${mode}`
    );
    const statuses = mergeStatuses();
    if (statuses) log.info(`"Time to merge" waits for the Jira status: ${statuses.join(", ")} (MERGE_STATUS in settings)`);
    if (options.intervalMs !== undefined) log.info("--interval is set, so POLL_INTERVAL in the settings is ignored");
    const listener =
      bot && listen
        ? new Bot({
            api: bot.api,
            chatId: bot.chatId,
            profile,
            commands,
            source,
            stores,
            state: new BotStateStore(config.dir),
            log,
            signal: controller.signal,
            settings,
            ...(settingsStore ? { settingsStore } : {}),
            ...(options.intervalMs !== undefined ? { intervalFlagMs: options.intervalMs } : {}),
          }).run()
        : Promise.resolve();
    const ok = await runLoop({
      tick: () => {
        const statuses = mergeStatuses();
        return runTick({ commands, source, stores, sink, log, ...(statuses ? { mergeStatuses: statuses } : {}) });
      },
      sink,
      monitor: new FailureMonitor(),
      log,
      intervalMs,
      once,
      signal: controller.signal,
    });
    controller.abort();
    await listener;
    return ok ? 0 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    for (const lock of locks) lock.release();
  }
}
