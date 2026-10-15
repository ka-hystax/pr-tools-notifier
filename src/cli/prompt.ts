import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Prompter } from "../commands/init.js";

export interface ClosablePrompter extends Prompter {
  close(): void;
}

export function createPrompter(): ClosablePrompter {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });

  return {
    ask: (question) => rl.question(question),
    async secret(question) {
      process.stdout.write(question);
      muted = true;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        process.stdout.write("\n");
      }
    },
    async confirm(question) {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    },
    close: () => rl.close(),
  };
}
