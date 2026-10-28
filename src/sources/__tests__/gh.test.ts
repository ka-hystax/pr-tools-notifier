import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ghSource, ghTrackProbe, readRateLimit, type Exec, type ExecOptions } from "../gh.js";
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

function withStderr(stdout: string, stderr: string): Exec {
  return async () => ({ stdout, stderr });
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

  describe("track", () => {
    const trackJson = readFixtureText("track");
    const list = (hasTickets: boolean) => ({ listPath: "/cfg/tracked/work.txt", hasTickets: () => hasTickets });

    test("reads the tracked list file", async () => {
      const { exec, calls } = fake(trackJson);
      const snapshot = await ghSource({ profile: "work", exec, track: list(true) })("track");
      expect(snapshot.command).toBe("track");
      expect(calls[0]!.args).toEqual(["pr-tools", "-p", "work", "track", "--json", "--list", "/cfg/tracked/work.txt"]);
    });

    test("fails when the list names tickets and gh-pr-tools does not report them", async () => {
      const withoutTickets = JSON.stringify({ ...JSON.parse(trackJson), tickets: undefined });
      await expect(ghSource({ profile: "work", exec: fake(withoutTickets).exec, track: list(true) })("track")).rejects.toThrow(
        "gh-pr-tools track does not take Jira tickets (the tracked list names some)"
      );
      const numbersOnly = await ghSource({ profile: "work", exec: fake(withoutTickets).exec, track: list(false) })("track");
      expect(numbersOnly.command === "track" && numbersOnly.tickets).toBeUndefined();
    });
  });

  describe("Jira tickets", () => {
    const withoutJira = JSON.stringify({
      ...JSON.parse(mineJson),
      prs: JSON.parse(mineJson).prs.map(({ jira: _jira, ...pr }: Record<string, unknown>) => pr),
    });
    const withJira = JSON.stringify({
      ...JSON.parse(mineJson),
      prs: JSON.parse(mineJson).prs.map((pr: object, i: number) => ({
        ...pr,
        jira: i === 0 ? { key: "PRJ-1", url: null, status: null } : null,
      })),
    });

    test("a gh-pr-tools that does not report them is refused when the merge gate needs them", async () => {
      const source = ghSource({ profile: "w", exec: fake(withoutJira).exec, jiraRequired: true });
      await expect(source("mine")).rejects.toThrow("gh-pr-tools does not report Jira tickets");
    });

    test("is accepted when every PR carries the field, null or not", async () => {
      const snapshot = await ghSource({ profile: "w", exec: fake(withJira).exec, jiraRequired: true })("mine");
      expect(snapshot.command === "mine" && snapshot.prs[0]!.jira).toEqual({ key: "PRJ-1", url: null, status: null });
    });

    test("follows a setting that changes while running", async () => {
      let required = false;
      const source = ghSource({ profile: "w", exec: fake(withoutJira).exec, jiraRequired: () => required });
      await expect(source("mine")).resolves.toBeDefined();
      required = true;
      await expect(source("mine")).rejects.toThrow("does not report Jira tickets");
    });

    test("is not looked for without the gate, and never for todo", async () => {
      await expect(ghSource({ profile: "w", exec: fake(withoutJira).exec })("mine")).resolves.toBeDefined();
      await expect(ghSource({ profile: "w", exec: fake(todoJson).exec, jiraRequired: true })("todo")).resolves.toBeDefined();
    });
  });

  test("passes what gh-pr-tools prints on stderr to the warning hook", async () => {
    const lines: string[] = [];
    const exec = withStderr(mineJson, "gh pr-tools: Jira rejected the API token (HTTP 401)\n\n  second line \n");
    await ghSource({ profile: "w", exec, onWarning: (l) => lines.push(l) })("mine");
    expect(lines).toEqual(["gh pr-tools: Jira rejected the API token (HTTP 401)", "second line"]);
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

describe("ghTrackProbe", () => {
  test("asks track about the references through a list file of its own, then removes it", async () => {
    let list = "";
    let path = "";
    const exec: Exec = async (_file, args) => {
      path = args.at(-1)!;
      list = readFileSync(path, "utf8");
      return { stdout: readFixtureText("track"), stderr: "gh pr-tools track: 'XYZ-1' is not a PR number … — skipped" };
    };
    const snapshot = await ghTrackProbe({ profile: "work", exec })(["PRJ-2001", "XYZ-1"]);
    expect(snapshot.command).toBe("track");
    expect(list).toBe("PRJ-2001\nXYZ-1\n");
    expect(existsSync(path)).toBe(false);
  });

  test("rejects a snapshot of another command", async () => {
    await expect(ghTrackProbe({ profile: "w", exec: fake(mineJson).exec })(["1"])).rejects.toThrow(
      /expected a track snapshot, got mine/
    );
  });
});

describe("readRateLimit", () => {
  const limits = (graphql: number, core = 4000) =>
    JSON.stringify({
      resources: {
        core: { limit: 5000, remaining: core, reset: 1_792_000_000 },
        graphql: { limit: 5000, remaining: graphql, reset: 1_792_003_600 },
      },
    });

  test("returns the hourly limit that is nearly used up, with its reset time", async () => {
    const { exec, calls } = fake(limits(12));
    expect(await readRateLimit({ exec })).toEqual({ resource: "graphql", limit: 5000, resetAt: new Date(1_792_003_600_000) });
    expect(calls[0]).toMatchObject({ file: "gh", args: ["api", "rate_limit"] });
    expect(await readRateLimit({ exec: fake(limits(4000, 3)).exec })).toMatchObject({ resource: "core" });
  });

  test("returns null when no hourly limit ran out, as with a secondary limit", async () => {
    expect(await readRateLimit({ exec: fake(limits(4000)).exec })).toBeNull();
  });

  test("explains a failure to ask", async () => {
    await expect(readRateLimit({ exec: failing({ code: "ENOENT" }) })).rejects.toThrow("gh was not found in PATH");
  });
});
