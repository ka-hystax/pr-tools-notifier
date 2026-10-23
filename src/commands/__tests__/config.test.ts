import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SettingsStore } from "../../config/settings.js";
import { runConfig, type ConfigAction } from "../config.js";

let dir: string;
let store: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prn-config-"));
  store = new SettingsStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(action: ConfigAction) {
  const out: string[] = [];
  const ok = runConfig(store, action, (line) => out.push(line));
  return { ok, out: out.join("\n") };
}

describe("runConfig", () => {
  test("shows the defaults and where the file will be", () => {
    const r = run({ type: "show" });
    expect(r.ok).toBe(true);
    expect(r.out).toContain(`${store.path} (not created yet)`);
    expect(r.out).toMatch(/MERGE_STATUS\s+not set/);
    expect(r.out).toMatch(/POLL_INTERVAL\s+1m \(default\)/);
  });

  test("sets a value, then shows it", () => {
    const set = run({ type: "set", key: "merge-status", value: "Merge,Ready to merge" });
    expect(set).toMatchObject({ ok: true });
    expect(set.out).toContain("MERGE_STATUS=Merge,Ready to merge saved");
    run({ type: "set", key: "poll-interval", value: "5m" });
    const shown = run({ type: "show" }).out;
    expect(shown).toMatch(/MERGE_STATUS\s+Merge, Ready to merge/);
    expect(shown).toMatch(/POLL_INTERVAL\s+5m /);
    expect(store.load()).toEqual({ mergeStatuses: ["Merge", "Ready to merge"], intervalMs: 300_000 });
  });

  test("explains an unknown key and a bad value without changing the file", () => {
    expect(run({ type: "set", key: "merge-statuses", value: "Merge" })).toEqual({
      ok: false,
      out: "Unknown setting 'merge-statuses' (known: merge-status, poll-interval).",
    });
    expect(run({ type: "set", key: "poll-interval", value: "13h" })).toEqual({
      ok: false,
      out: "POLL_INTERVAL must be at most 12h",
    });
    expect(store.exists()).toBe(false);
  });

  test("unsets a value, and says so when there was none", () => {
    run({ type: "set", key: "merge-status", value: "Merge" });
    expect(run({ type: "unset", key: "merge-status" })).toMatchObject({ ok: true, out: expect.stringContaining("removed") });
    expect(run({ type: "unset", key: "merge-status" }).out).toBe("MERGE_STATUS was not set.");
    expect(run({ type: "unset", key: "nope" })).toMatchObject({ ok: false });
  });

  test("reports a broken file instead of throwing", () => {
    writeFileSync(store.path, "MERGE_STATUSES=Merge\n");
    const r = run({ type: "show" });
    expect(r.ok).toBe(false);
    expect(r.out).toContain("unknown setting 'MERGE_STATUSES'");
  });
});
