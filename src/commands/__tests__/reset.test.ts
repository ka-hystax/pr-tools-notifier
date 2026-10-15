import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runReset } from "../reset.js";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-reset-"));
  dir = join(root, "pr-tools-notifier");
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run({ yes = false, answer = true, locks = [] as string[], target = dir } = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const done = runReset({
    prompter: {
      async confirm(question) {
        asked.push(question);
        return answer;
      },
    },
    dir: target,
    yes,
    out: (line) => out.push(line),
    activeLocks: () => locks,
  });
  return { done, out, asked };
}

describe("runReset", () => {
  test("deletes the directory after a yes, and reminds about the bot", async () => {
    const r = run();
    expect(await r.done).toBe(true);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toContain(dir);
    expect(existsSync(dir)).toBe(false);
    expect(r.out.join("\n")).toMatch(/\/deletebot.*@BotFather/);
    expect(r.out.join("\n")).toContain("gh-pr-tools settings were not touched");
  });

  test("keeps everything when the answer is no", async () => {
    const r = run({ answer: false });
    expect(await r.done).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(r.out).toEqual(["Nothing changed."]);
  });

  test("skips the question with --yes", async () => {
    const r = run({ yes: true });
    expect(await r.done).toBe(true);
    expect(r.asked).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test("refuses while a run holds a lock", async () => {
    const r = run({ yes: true, locks: ["x.lock"] });
    expect(await r.done).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(r.out[0]).toMatch(/still running/);
  });

  test("reports an absent directory as done without asking", async () => {
    const missing = join(root, "nope");
    const r = run({ target: missing });
    expect(await r.done).toBe(true);
    expect(r.asked).toEqual([]);
    expect(r.out[0]).toContain(`Nothing to remove: ${missing}`);
  });
});
