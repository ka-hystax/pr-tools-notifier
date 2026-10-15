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
      config: { profile: "work", dryRun: false, once: false, intervalMs: 60_000, commands: ["mine", "todo"] },
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

  test("shows help for no arguments or --help", () => {
    expect(parseCli([])).toEqual({ kind: "help" });
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["run", "-h"])).toEqual({ kind: "help" });
  });

  test("knows the init and send-test commands", () => {
    expect(parseCli(["init"])).toEqual({ kind: "init" });
    expect(parseCli(["send-test"])).toEqual({ kind: "send-test" });
    expect(() => parseCli(["init", "extra"])).toThrow(/unexpected argument 'extra'/);
  });

  test("requires a profile", () => {
    expect(() => parseCli(["run"])).toThrow(/--profile is required/);
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
