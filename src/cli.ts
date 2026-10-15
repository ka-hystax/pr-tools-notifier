#!/usr/bin/env node
import { join } from "node:path";
import { parseCli, UsageError, USAGE } from "./cli/args.js";
import { createPrompter } from "./cli/prompt.js";
import { readVersion } from "./cli/version.js";
import { runInit } from "./commands/init.js";
import { runReset } from "./commands/reset.js";
import { runCommand } from "./commands/run.js";
import { runSendTest } from "./commands/sendTest.js";
import { runStatus } from "./commands/status.js";
import { checkBot, NOT_CONFIGURED, telegramSink } from "./commands/sinks.js";
import { ConfigStore } from "./config/config.js";
import { configDir, stateDir } from "./config/paths.js";
import { activeLocks } from "./state/lock.js";
import { TelegramApi } from "./telegram/api.js";

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`pr-tools-notifier: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    console.log(`pr-tools-notifier ${readVersion()}`);
    return 0;
  }

  const config = new ConfigStore(configDir());

  if (parsed.kind === "init") {
    const prompter = createPrompter();
    try {
      const saved = await runInit({
        prompter,
        config,
        createApi: (token) => new TelegramApi({ token }),
        out: (line) => console.log(line),
      });
      return saved ? 0 : 1;
    } finally {
      prompter.close();
    }
  }

  if (parsed.kind === "reset") {
    const prompter = createPrompter();
    try {
      const state = stateDir();
      const done = await runReset({
        prompter,
        dir: configDir(),
        yes: parsed.yes,
        out: (line) => console.log(line),
        activeLocks: () => [...activeLocks(state), ...activeLocks(join(state, "dry-run"))],
      });
      return done ? 0 : 1;
    } finally {
      prompter.close();
    }
  }

  if (parsed.kind === "status") {
    const state = stateDir();
    const healthy = await runStatus({
      config,
      stateDir: state,
      check: (token) => checkBot(new TelegramApi({ token })),
      activeLocks: () => activeLocks(state),
      out: (line) => console.log(line),
    });
    return healthy ? 0 : 1;
  }

  if (parsed.kind === "send-test") {
    const sink = telegramSink(config);
    if (!sink) {
      console.error(NOT_CONFIGURED);
      return 1;
    }
    await runSendTest(sink, (line) => console.log(line));
    return 0;
  }

  return runCommand(parsed.config, config);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`pr-tools-notifier: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
);
