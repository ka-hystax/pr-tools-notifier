import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readVersion } from "../cli/version.js";
import { NOT_CONFIGURED } from "../commands/sinks.js";
import { ConfigStore } from "../config/config.js";
import { configDir } from "../config/paths.js";
import { main } from "../main.js";
import { readFixtureText } from "./fixtures.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-main-"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// Runs the CLI in-process and returns its exit code with everything it printed.
async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" "))),
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" "))),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    }),
  ];
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
}

// A stand-in for `gh pr-tools` that answers `-p PROFILE <command> --json`.
function fakePrTools(body: string): string {
  const path = join(root, "fake-pr-tools");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function snapshotsStub(): string {
  writeFileSync(join(root, "mine.json"), readFixtureText("mine"));
  writeFileSync(join(root, "todo.json"), readFixtureText("todo"));
  return fakePrTools(`case "$3" in mine) cat "${root}/mine.json";; todo) cat "${root}/todo.json";; esac`);
}

describe("main", () => {
  test("prints the version", async () => {
    expect(await cli("--version")).toMatchObject({ code: 0, out: `pr-tools-notifier ${readVersion()}` });
  });

  test("prints the usage without arguments", async () => {
    const r = await cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: pr-tools-notifier");
  });

  test("exits with 2 and the usage for an unknown command", async () => {
    const r = await cli("watch");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'watch'");
    expect(r.err).toContain("usage: pr-tools-notifier");
  });

  test.each([["send-test"], ["run", "-p", "demo", "--once"]])("%s asks for init when nothing is set up", async (...argv) => {
    const r = await cli(...argv);
    expect(r.code).toBe(1);
    expect(r.err).toContain(NOT_CONFIGURED);
  });

  test("status says nothing is set up and exits with 1", async () => {
    const r = await cli("status");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not set up");
    expect(r.out).toContain("none yet");
  });

  test("reset -y removes the configuration and reminds about the bot", async () => {
    new ConfigStore(configDir()).save({ botUsername: "demo_bot", chatId: "1", token: "123456:TOKEN" });
    const r = await cli("reset", "-y");
    expect(r.code).toBe(0);
    expect(existsSync(configDir())).toBe(false);
    expect(r.out).toContain("/deletebot");
  });

  test("reset has nothing to do without a configuration", async () => {
    expect(await cli("reset", "-y")).toMatchObject({ code: 0 });
  });

  test("a dry run saves a baseline first and finds nothing new on the next poll", async () => {
    const args = ["run", "-p", "demo", "--dry-run", "--once", "--pr-tools", snapshotsStub()];
    const first = await cli(...args);
    expect(first.code).toBe(0);
    expect(first.err).toMatch(/mine: first run, saved \d+ PRs as the baseline/);
    expect(existsSync(join(configDir(), "state", "dry-run", "demo-mine.json"))).toBe(true);

    const second = await cli(...args);
    expect(second.code).toBe(0);
    expect(second.err).toMatch(/mine: \d+ PRs, 0 new events/);
  });

  test("a run stops when the first poll reports an unknown profile", async () => {
    const stub = fakePrTools(`echo "gh pr-tools: unknown profile 'demo'" >&2\nexit 1`);
    const r = await cli("run", "-p", "demo", "--dry-run", "--pr-tools", stub);
    expect(r.code).toBe(1);
    expect(r.err).toContain("stopping: that gh-pr-tools profile does not exist");
  });
});
