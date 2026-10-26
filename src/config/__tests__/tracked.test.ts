import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runTrack } from "../../commands/track.js";
import { parseRef, TrackedList } from "../tracked.js";

let dir: string;
let list: TrackedList;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prn-tracked-"));
  list = new TrackedList(dir, "work");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (text: string) => {
  mkdirSync(dirname(list.path), { recursive: true });
  writeFileSync(list.path, text);
};
const read = () => readFileSync(list.path, "utf8");

describe("parseRef", () => {
  test.each([
    ["1281", { kind: "pr", number: 1281, text: "1281" }],
    ["#0160", { kind: "pr", number: 160, text: "160" }],
    [
      "https://github.com/acme/web/pull/12/files",
      { kind: "pr", number: 12, text: "https://github.com/acme/web/pull/12/files" },
    ],
    ["prj-1824", { kind: "ticket", key: "PRJ-1824", text: "PRJ-1824" }],
    ["https://acme.atlassian.net/browse/PRJ-1824/", { kind: "ticket", key: "PRJ-1824", text: "PRJ-1824" }],
    ["https://acme.atlassian.net/browse/PRJ-7?focusedCommentId=1", { kind: "ticket", key: "PRJ-7", text: "PRJ-7" }],
    [
      "https://acme.atlassian.net/jira/software/projects/PRJ/boards/1?selectedIssue=PRJ-1696",
      { kind: "ticket", key: "PRJ-1696", text: "PRJ-1696" },
    ],
  ])("reads %s", (input, entry) => {
    expect(parseRef(input)).toEqual(entry);
  });

  test.each(["", "0", "99999999999", "foo", "https://github.com/acme/web/issues/3", "PRJ-", "-12"])("refuses %j", (input) => {
    expect(parseRef(input)).toBeNull();
  });
});

describe("TrackedList", () => {
  test("is empty without a file", () => {
    expect(list.read()).toEqual({ entries: [], invalid: [] });
  });

  test("reads a list the way gh-pr-tools does", () => {
    write("﻿# QA list\r\n\n  1281   # waiting on CI\r\n#1282\nPRJ-1824\nnot a ref\n1281\n# 1299 not started\n");
    const { entries, invalid } = list.read();
    expect(entries.map((e) => e.text)).toEqual(["1281", "1282", "PRJ-1824"]);
    expect(invalid).toEqual(["not a ref"]);
  });

  test("starts a new file with a header that explains it, and appends what is new", () => {
    expect(list.add(["PRJ-1824", "1281"]).added.map((e) => e.text)).toEqual(["PRJ-1824", "1281"]);
    expect(read()).toMatch(/^# PRs and Jira tickets pr-tools-notifier follows/);
    const second = list.add(["#1281", "prj-1824", "foo", "1300"]);
    expect(second.added.map((e) => e.text)).toEqual(["1300"]);
    expect(second.already.map((e) => e.text)).toEqual(["1281", "PRJ-1824"]);
    expect(second.invalid).toEqual(["foo"]);
    expect(list.read().entries.map((e) => e.text)).toEqual(["PRJ-1824", "1281", "1300"]);
  });

  test("adds the header to a file that is there but empty", () => {
    write("\n");
    list.add(["PRJ-1"]);
    expect(read()).toMatch(/^# PRs and Jira tickets[^]*\nPRJ-1\n$/);
  });

  test("keeps comments and the other lines when it adds or removes", () => {
    write("# mine\n1281  # note\nPRJ-1\n");
    list.add(["PRJ-2"]);
    expect(read()).toBe("# mine\n1281  # note\nPRJ-1\nPRJ-2\n");
    expect(list.remove([parseRef("https://github.com/acme/web/pull/1281")!]).map((e) => e.text)).toEqual(["1281"]);
    expect(read()).toBe("# mine\nPRJ-1\nPRJ-2\n");
    expect(list.remove([parseRef("PRJ-9")!])).toEqual([]);
  });

  test("refuses a profile name that is not a file name", () => {
    expect(() => new TrackedList(dir, "../x")).toThrow(/invalid profile name/);
  });
});

describe("runTrack", () => {
  const run = (action: Parameters<typeof runTrack>[1]) => {
    const out: string[] = [];
    const ok = runTrack(list, action, (line) => out.push(line));
    return { ok, out: out.join("\n") };
  };

  test("says how to start when nothing is tracked", () => {
    expect(run({ type: "show" }).out).toContain("Nothing is tracked yet");
  });

  test("adds, shows and removes, and fails on what it does not understand", () => {
    expect(run({ type: "add", refs: ["PRJ-1824", "1281"] })).toEqual({
      ok: true,
      out: "Tracking PRJ-1824, #1281. A running `pr-tools-notifier run` picks it up on its next poll.",
    });
    expect(run({ type: "add", refs: ["1281", "foo"] })).toEqual({
      ok: false,
      out: "Already tracked: #1281.\n'foo' is not a PR number, a PR link or a Jira ticket.",
    });
    expect(run({ type: "show" }).out).toBe(`Tracked list: ${list.path}\n  PRJ-1824 (every PR of the ticket)\n  #1281`);
    expect(run({ type: "rm", refs: ["#1281", "PRJ-2"] })).toEqual({
      ok: true,
      out: "No longer tracking #1281. A running `pr-tools-notifier run` picks it up on its next poll.\nNot tracked: PRJ-2.",
    });
  });
});
