#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`pr-tools-notifier: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
);
