import { describe, expect, test } from "vitest";
import { ghSource, type Exec, type ExecOptions } from "../gh.js";
import { readFixtureText } from "../../__tests__/fixtures.js";

const mineJson = readFixtureText("mine");
const todoJson = readFixtureText("todo");

interface Call {
  file: string;
  args: string[];
  options: ExecOptions;
}

function fake(stdout: string): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout, stderr: "" };
    },
  };
}

function failing(error: object): Exec {
  return async () => {
    throw Object.assign(new Error("failed"), error);
  };
}

describe("ghSource", () => {
  test("runs `gh pr-tools -p PROFILE <command> --json` and returns the validated snapshot", async () => {
    const { exec, calls } = fake(mineJson);
    const snapshot = await ghSource({ profile: "work", exec })("mine");
    expect(snapshot.command).toBe("mine");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: "gh", args: ["pr-tools", "-p", "work", "mine", "--json"] });
    expect(calls[0]!.options.timeout).toBe(120_000);
  });

  test("can run a gh-pr-tools checkout directly", async () => {
    const { exec, calls } = fake(todoJson);
    await ghSource({ profile: "work", prToolsPath: "/x/gh-pr-tools", exec })("todo");
    expect(calls[0]).toMatchObject({ file: "/x/gh-pr-tools", args: ["-p", "work", "todo", "--json"] });
  });

  test("passes the abort signal and a custom timeout through", async () => {
    const { exec, calls } = fake(mineJson);
    const controller = new AbortController();
    await ghSource({ profile: "work", signal: controller.signal, timeoutMs: 5_000, exec })("mine");
    expect(calls[0]!.options.signal).toBe(controller.signal);
    expect(calls[0]!.options.timeout).toBe(5_000);
  });

  test("explains a missing gh", async () => {
    const source = ghSource({ profile: "work", exec: failing({ code: "ENOENT" }) });
    await expect(source("mine")).rejects.toThrow("gh was not found in PATH");
  });

  test("reports the exit code and the tail of stderr", async () => {
    const source = ghSource({ profile: "work", exec: failing({ code: 1, stderr: "a\nb\nc\nunknown option '--json'\n" }) });
    await expect(source("todo")).rejects.toThrow("exited with 1: b | c | unknown option '--json'");
  });

  test("reports a timeout and an abort", async () => {
    await expect(ghSource({ profile: "w", timeoutMs: 3000, exec: failing({ killed: true }) })("mine")).rejects.toThrow(
      "timed out after 3s"
    );
    await expect(ghSource({ profile: "w", exec: failing({ name: "AbortError" }) })("mine")).rejects.toThrow("aborted");
  });

  test("rejects output that is not JSON", async () => {
    await expect(ghSource({ profile: "w", exec: fake("oops").exec })("mine")).rejects.toThrow("output is not valid JSON");
  });

  test("rejects a document that breaks the contract, with the contract's own message", async () => {
    const outdated = JSON.stringify({ ...JSON.parse(mineJson), schemaVersion: 2 });
    await expect(ghSource({ profile: "w", exec: fake(outdated).exec })("mine")).rejects.toThrow(/^unsupported schemaVersion 2/);
  });

  test("rejects a snapshot of the wrong command", async () => {
    await expect(ghSource({ profile: "w", exec: fake(todoJson).exec })("mine")).rejects.toThrow(
      /expected a mine snapshot, got todo/
    );
  });
});
