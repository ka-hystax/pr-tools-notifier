import { join } from "node:path";
import { Bot } from "../bot/bot.js";
import { BotStateStore } from "../bot/state.js";
import type { RunConfig } from "../cli/args.js";
import { createLogger, prefixed } from "../cli/logger.js";
import type { ConfigStore } from "../config/config.js";
import { DEFAULT_INTERVAL_MS, formatInterval } from "../config/interval.js";
import { stateDir } from "../config/paths.js";
import type { Settings, SettingsStore } from "../config/settings.js";
import { TrackedList } from "../config/tracked.js";
import { DryRunSink } from "../runner/dryRun.js";
import { runLoop } from "../runner/loop.js";
import { FailureMonitor } from "../runner/monitor.js";
import { RateLimitNotice } from "../runner/rateLimit.js";
import { runTick } from "../runner/tick.js";
import { errorMessage, type Logger } from "../runner/types.js";
import { ghSource, ghTrackProbe, readRateLimit } from "../sources/gh.js";
import { listProfiles, ProfileError } from "../sources/profiles.js";
import { acquireLock, LockError, type Lock } from "../state/lock.js";
import { StateStore } from "../state/store.js";
import { ensurePrivateDir } from "../utils/fs.js";
import { checkBot, NOT_CONFIGURED, serialSink, telegramBot } from "./sinks.js";

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
  const { dryRun, once, prToolsPath } = options;
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
  const sink = serialSink(bot?.sink ?? new DryRunSink());

  let names: string[];
  try {
    names =
      options.profiles.length > 0
        ? options.profiles.map((p) => p.name)
        : await listProfiles(prToolsPath ? { prToolsPath } : {});
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    console.error(`pr-tools-notifier: ${err.message}`);
    return 1;
  }

  const log = createLogger();
  const settings = liveSettings(settingsStore, log);
  const intervalMs = () => pollInterval(options, settings());
  const dir = dryRun ? join(stateDir(), "dry-run") : stateDir();
  const several = names.length > 1;
  const profiles = names.map((name) => {
    const commands = options.profiles.find((p) => p.name === name)?.commands ?? options.commands;
    const stores = {
      mine: new StateStore(dir, name, "mine"),
      todo: new StateStore(dir, name, "todo"),
      track: new StateStore(dir, name, "track"),
    };
    const tracked = new TrackedList(config.dir, name);
    return { name, commands, stores, tracked, log: several ? prefixed(log, name) : log };
  });

  const locks: Lock[] = [];
  let listen = !dryRun && !once;
  try {
    for (const profile of profiles) for (const command of profile.commands) locks.push(profile.stores[command].lock());
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
    const mode = dryRun ? "dry run" : "sending to Telegram";
    const polled = profiles.map((profile) => {
      const mergeStatuses = () => (profile.commands.includes("mine") ? settings().mergeStatuses : undefined);
      const trackedEntries = () => profile.tracked.read().entries;
      // A skipped list line comes back on every poll: say it once.
      const warned = new Set<string>();
      const source = ghSource({
        profile: profile.name,
        signal: controller.signal,
        onWarning: (line) => {
          if (!warned.has(line)) profile.log.warn(line);
          if (line.startsWith("gh pr-tools track:")) warned.add(line);
        },
        ...(prToolsPath ? { prToolsPath } : {}),
        jiraRequired: () => mergeStatuses() !== undefined,
        track: { listPath: profile.tracked.path, hasTickets: () => trackedEntries().some((e) => e.kind === "ticket") },
      });
      const probe = ghTrackProbe({ profile: profile.name, signal: controller.signal, ...(prToolsPath ? { prToolsPath } : {}) });
      const named = options.profiles.length > 0 ? "" : several ? " (found with `gh pr-tools profile list`)" : " (the only one)";
      log.info(
        `profile ${profile.name}${named}: ${profile.commands.join(" + ")}${once ? ", one poll" : `, every ${formatInterval(intervalMs())}`}, ${mode}`
      );
      if (profile.commands.includes("track")) {
        const count = trackedEntries().length;
        profile.log.info(
          count > 0
            ? `following ${count} PRs and tickets from ${profile.tracked.path}`
            : "nothing tracked yet (/track in the bot)"
        );
      }
      return { ...profile, source, probe, mergeStatuses, trackedEntries };
    });
    const statuses = settings().mergeStatuses;
    if (statuses && polled.some((p) => p.commands.includes("mine"))) {
      log.info(`"Time to merge" waits for the Jira status: ${statuses.join(", ")} (MERGE_STATUS in settings)`);
    }
    if (options.intervalMs !== undefined) log.info("--interval is set, so POLL_INTERVAL in the settings is ignored");
    const listener =
      bot && listen
        ? new Bot({
            api: bot.api,
            chatId: bot.chatId,
            profiles: polled.map((p) => ({
              profile: p.name,
              commands: p.commands,
              source: p.source,
              stores: p.stores,
              tracked: p.tracked,
              probe: p.probe,
            })),
            state: new BotStateStore(config.dir),
            log,
            signal: controller.signal,
            settings,
            ...(settingsStore ? { settingsStore } : {}),
            ...(options.intervalMs !== undefined ? { intervalFlagMs: options.intervalMs } : {}),
          }).run()
        : Promise.resolve();
    const rateLimit = new RateLimitNotice({
      read: () => readRateLimit({ signal: controller.signal }),
      sink,
      log,
      intervalMs,
      intervalFlag: options.intervalMs !== undefined,
    });
    const results = await Promise.all(
      polled.map(async (profile) => {
        const monitor = new FailureMonitor(3, several ? profile.name : undefined);
        const ok = await runLoop({
          tick: async () => {
            const statuses = profile.mergeStatuses();
            const result = await runTick({
              commands: profile.commands,
              source: profile.source,
              stores: profile.stores,
              sink,
              log: profile.log,
              hasTracked: () => profile.trackedEntries().length > 0,
              ...(statuses ? { mergeStatuses: statuses } : {}),
              ...(several ? { repoLabel: true } : {}),
            });
            // The rate limit notice says more than the general alert would, so that one is not sent for it.
            if (!result.ok && (await rateLimit.check(result.errors))) monitor.markAlerted();
            return result;
          },
          sink,
          monitor,
          log: profile.log,
          intervalMs,
          once,
          signal: controller.signal,
          trackOnly: profile.commands.length === 1 && profile.commands[0] === "track",
        });
        // A loop ends by itself only on a setup mistake, and that stops the whole run.
        if (!once) controller.abort();
        return ok;
      })
    );
    controller.abort();
    await listener;
    return results.every(Boolean) ? 0 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    for (const lock of locks) lock.release();
  }
}
