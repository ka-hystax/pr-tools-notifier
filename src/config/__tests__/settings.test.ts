import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readInterval } from "../interval.js";
import { settingKey, SettingsError, SettingsStore } from "../settings.js";

let dir: string;
let store: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prn-settings-"));
  store = new SettingsStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (text: string) => writeFileSync(store.path, text);
const read = () => readFileSync(store.path, "utf8");

describe("readInterval", () => {
  test.each([
    ["60s", 60_000],
    ["1m", 60_000],
    ["90", 90_000],
    ["12h", 43_200_000],
    ["720m", 43_200_000],
  ])("accepts %s", (text, ms) => {
    expect(readInterval(text)).toEqual({ ms });
  });

  test("tells a bad format from a value out of range", () => {
    expect(readInterval("soon")).toEqual({ error: "format" });
    expect(readInterval("59s")).toEqual({ error: "min" });
    expect(readInterval("12h1")).toEqual({ error: "format" });
    expect(readInterval("43201s")).toEqual({ error: "max" });
  });
});

describe("settingKey", () => {
  test.each(["merge-status", "MERGE_STATUS", " Merge_Status "])("recognizes %j", (text) => {
    expect(settingKey(text)).toBe("MERGE_STATUS");
  });

  test("returns null for anything else", () => {
    expect(settingKey("merge-statuses")).toBeNull();
    expect(settingKey("")).toBeNull();
  });
});

describe("SettingsStore.load", () => {
  test("is empty without a file", () => {
    expect(store.exists()).toBe(false);
    expect(store.load()).toEqual({});
  });

  test("reads the statuses as a comma-separated string and the interval", () => {
    write("MERGE_STATUS=Merge, Ready to merge,,merge\nPOLL_INTERVAL=5m\n");
    expect(store.load()).toEqual({ mergeStatuses: ["Merge", "Ready to merge", "merge"], intervalMs: 300_000 });
  });

  test("skips comments and blank lines, accepts export, quotes and any letter case in the key", () => {
    write("# the team workflow\n\nexport MERGE_STATUS=\"Merge\"\n  poll-interval = '2m'  \n");
    expect(store.load()).toEqual({ mergeStatuses: ["Merge"], intervalMs: 120_000 });
  });

  test("treats an empty value as not set", () => {
    write("MERGE_STATUS=\nPOLL_INTERVAL=\n");
    expect(store.load()).toEqual({});
  });

  test("refuses a typo instead of ignoring it, naming the file and the line", () => {
    write("# comment\nMERGE_STATUSES=Merge\n");
    expect(() => store.load()).toThrow(SettingsError);
    expect(() => store.load()).toThrow(
      `${store.path}:2: unknown setting 'MERGE_STATUSES' (known: MERGE_STATUS, POLL_INTERVAL)`
    );
  });

  test.each([
    ["POLL_INTERVAL=30s", "POLL_INTERVAL must be at least 1m"],
    ["POLL_INTERVAL=13h", "POLL_INTERVAL must be at most 12h"],
    ["POLL_INTERVAL=often", "POLL_INTERVAL use e.g. 90s, 5m or 1h"],
    ["just words", "expected KEY=value"],
  ])("refuses %j", (line, message) => {
    write(`${line}\n`);
    expect(() => store.load()).toThrow(`${store.path}:1: ${message}`);
  });
});

describe("SettingsStore.set and unset", () => {
  test("creates the file with a header and the value normalized", () => {
    expect(store.set("MERGE_STATUS", " Merge , Ready ,Merge")).toBe("Merge,Ready");
    expect(read()).toBe("# pr-tools-notifier settings: KEY=value, one per line\nMERGE_STATUS=Merge,Ready\n");
  });

  test("changes the one line and leaves comments and other settings alone", () => {
    write("# mine\nPOLL_INTERVAL=5m\n# statuses\nmerge-status=Old\nOTHER_TOOL=keep\n".replace("OTHER_TOOL=keep\n", ""));
    store.set("MERGE_STATUS", "Merge");
    expect(read()).toBe("# mine\nPOLL_INTERVAL=5m\n# statuses\nMERGE_STATUS=Merge\n");
  });

  test("appends a missing key after the existing lines", () => {
    write("POLL_INTERVAL=5m\n");
    store.set("MERGE_STATUS", "Merge");
    expect(read()).toBe("POLL_INTERVAL=5m\nMERGE_STATUS=Merge\n");
  });

  test("validates before writing anything", () => {
    expect(() => store.set("POLL_INTERVAL", "30s")).toThrow("POLL_INTERVAL must be at least 1m");
    expect(store.exists()).toBe(false);
  });

  test("an empty value removes the key", () => {
    write("MERGE_STATUS=Merge\nPOLL_INTERVAL=5m\n");
    expect(store.set("MERGE_STATUS", "  ")).toBe("");
    expect(read()).toBe("POLL_INTERVAL=5m\n");
  });

  test("unset reports whether there was anything to remove", () => {
    write("MERGE_STATUS=Merge\n");
    expect(store.unset("MERGE_STATUS")).toBe(true);
    expect(store.unset("MERGE_STATUS")).toBe(false);
    expect(store.unset("POLL_INTERVAL")).toBe(false);
    expect(store.load()).toEqual({});
  });
});
