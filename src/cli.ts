#!/usr/bin/env node
import { parseCli, UsageError, USAGE } from "./cli/args.js";
import { createPrompter } from "./cli/prompt.js";
import { runInit } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { runSendTest } from "./commands/sendTest.js";
import { NOT_CONFIGURED, telegramSink } from "./commands/sinks.js";
import { ConfigStore } from "./config/config.js";
import { configDir } from "./config/paths.js";
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
