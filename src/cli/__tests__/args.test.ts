import { describe, expect, test } from "vitest";
import { parseCli, parseCommands, parseInterval, UsageError } from "../args.js";

describe("parseInterval", () => {
  test.each([
    ["5m", 300_000],
    ["90s", 90_000],
    ["1h", 3_600_000],
    ["120", 120_000],
  ])("reads %s", (text, ms) => {
    expect(parseInterval(text)).toBe(ms);
  });

  test.each(["", "abc", "5x", "-5m", "1.5m", "5 m"])("rejects %j", (text) => {
    expect(() => parseInterval(text)).toThrow(UsageError);
  });

  test("refuses anything over twelve hours", () => {
    expect(() => parseInterval("13h")).toThrow(/at most 12h/);
    expect(() => parseInterval("43201")).toThrow(/at most 12h/);
    expect(parseInterval("720m")).toBe(43_200_000);
  });

  test("refuses anything under a minute", () => {
    expect(() => parseInterval("30s")).toThrow(/at least 1m/);
    expect(() => parseInterval("0")).toThrow(/at least 1m/);
  });
});

describe("parseCommands", () => {
  test("accepts mine and todo in any order and drops duplicates", () => {
    expect(parseCommands("todo,mine,todo")).toEqual(["todo", "mine"]);
    expect(parseCommands(" mine ")).toEqual(["mine"]);
  });

  test.each(["track", "", "mine,,todo", "mine,prd"])("rejects %j", (text) => {
    expect(() => parseCommands(text)).toThrow(UsageError);
  });
});

describe("parseCli", () => {
  test("applies the defaults", () => {
    expect(parseCli(["run", "-p", "work"])).toEqual({
      kind: "run",
      config: { profile: "work", dryRun: false, once: false, commands: ["mine", "todo"] },
    });
  });

  test("reads every option", () => {
    const parsed = parseCli([
      "run",
      "--profile",
      "work",
      "--dry-run",
      "--once",
      "--interval",
      "2m",
      "--commands",
      "mine",
      "--pr-tools",
      "/x/gh-pr-tools",
    ]);
    expect(parsed).toEqual({
      kind: "run",
      config: {
        profile: "work",
        dryRun: true,
        once: true,
        intervalMs: 120_000,
        commands: ["mine"],
        prToolsPath: "/x/gh-pr-tools",
      },
    });
  });

  test("leaves the interval to the settings unless --interval is given", () => {
    expect(parseCli(["run", "-p", "work"])).not.toHaveProperty("config.intervalMs");
    expect(parseCli(["run", "-p", "work", "--interval", "12h"])).toMatchObject({ config: { intervalMs: 43_200_000 } });
  });

  test("reads the config command and its actions", () => {
    expect(parseCli(["config"])).toEqual({ kind: "config", action: { type: "show" } });
    expect(parseCli(["config", "set", "merge-status", "Merge, Ready to merge"])).toEqual({
      kind: "config",
      action: { type: "set", key: "merge-status", value: "Merge, Ready to merge" },
    });
    expect(parseCli(["config", "unset", "POLL_INTERVAL"])).toEqual({
      kind: "config",
      action: { type: "unset", key: "POLL_INTERVAL" },
    });
  });

  test.each([
    [["config", "set"], /usage: config set/],
    [["config", "set", "merge-status"], /usage: config set/],
    [["config", "set", "merge-status", "Ready", "to", "merge"], /unexpected argument 'to'/],
    [["config", "unset"], /usage: config unset/],
    [["config", "unset", "a", "b"], /usage: config unset/],
    [["config", "get"], /unknown config action 'get'/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCli(argv)).toThrow(message);
  });

  test("no longer knows --merge-status: the Jira status lives in the settings", () => {
    expect(() => parseCli(["run", "-p", "work", "--merge-status", "Merge"])).toThrow(UsageError);
  });

  test("shows help for no arguments or --help", () => {
    expect(parseCli([])).toEqual({ kind: "help" });
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["run", "-h"])).toEqual({ kind: "help" });
  });

  test("reads --version and -v, which win over a command", () => {
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
    expect(parseCli(["-v"])).toEqual({ kind: "version" });
    expect(parseCli(["run", "--version"])).toEqual({ kind: "version" });
  });

  test("knows the init, status and send-test commands", () => {
    expect(parseCli(["status"])).toEqual({ kind: "status" });
    expect(parseCli(["init"])).toEqual({ kind: "init" });
    expect(parseCli(["send-test"])).toEqual({ kind: "send-test" });
    expect(() => parseCli(["init", "extra"])).toThrow(/unexpected argument 'extra'/);
  });

  test("reads reset and its --yes flag", () => {
    expect(parseCli(["reset"])).toEqual({ kind: "reset", yes: false });
    expect(parseCli(["reset", "-y"])).toEqual({ kind: "reset", yes: true });
    expect(parseCli(["reset", "--yes"])).toEqual({ kind: "reset", yes: true });
    expect(() => parseCli(["init", "--yes"])).toThrow(/only for reset/);
    expect(() => parseCli(["run", "-p", "x", "-y"])).toThrow(/only for reset/);
  });

  test("leaves the profile open when it is not named: the only one is used", () => {
    expect(parseCli(["run"])).toEqual({
      kind: "run",
      config: { dryRun: false, once: false, commands: ["mine", "todo"] },
    });
  });

  test("rejects unknown commands and options", () => {
    expect(() => parseCli(["watch", "-p", "x"])).toThrow(/unknown command 'watch'/);
    expect(() => parseCli(["run", "-p", "x", "--nope"])).toThrow(UsageError);
    expect(() => parseCli(["run", "extra", "-p", "x"])).toThrow(UsageError);
  });

  test("passes interval and command errors through as usage errors", () => {
    expect(() => parseCli(["run", "-p", "x", "--interval", "10s"])).toThrow(/at least 1m/);
    expect(() => parseCli(["run", "-p", "x", "--commands", "track"])).toThrow(/unknown command 'track'/);
  });
});
