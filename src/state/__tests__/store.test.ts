import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSnapshot } from "../../contract/snapshot.js";
import { computeEvents, type Baseline } from "../../diff/diff.js";
import { LockError } from "../lock.js";
import { StateStore } from "../store.js";
import { readFixture as fixture } from "../../__tests__/fixtures.js";

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-store-"));
  dir = join(root, "state");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseline = (): Baseline => ({ snapshot: parseSnapshot(fixture("mine")), missingTicks: { 102: 1 } });

describe("StateStore", () => {
  test("reports a first run when there is no file", () => {
    expect(new StateStore(dir, "work", "mine").load()).toEqual({ baseline: null });
  });

  test("round-trips a baseline", () => {
    const store = new StateStore(dir, "work", "mine");
    store.save(baseline());
    expect(store.load()).toEqual({ baseline: baseline() });
  });

  test("keeps a separate file per profile and command", () => {
    new StateStore(dir, "work", "mine").save(baseline());
    expect(new StateStore(dir, "work", "todo").load().baseline).toBeNull();
    expect(new StateStore(dir, "side", "mine").load().baseline).toBeNull();
  });

  test("creates a private directory and file", () => {
    const store = new StateStore(dir, "work", "mine");
    store.save(baseline());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  test("replaces the file atomically and leaves no temp files behind", () => {
    const store = new StateStore(dir, "work", "mine");
    store.save(baseline());
    store.save({ ...baseline(), missingTicks: {} });
    expect(store.load().baseline?.missingTicks).toEqual({});
    expect(readdirSync(dir)).toEqual(["work-mine.json"]);
  });

  test("sets aside a file that is not JSON and starts fresh", () => {
    const store = new StateStore(dir, "work", "mine");
    store.save(baseline());
    writeFileSync(store.path, "{ truncated");
    const result = store.load();
    expect(result.baseline).toBeNull();
    expect(result.reset).toMatch(/not valid JSON; moved to .*work-mine\.json\.corrupt/);
    expect(existsSync(`${store.path}.corrupt`)).toBe(true);
    expect(store.load()).toEqual({ baseline: null });
  });

  test("sets aside a file with an unknown version or an outdated snapshot", () => {
    const store = new StateStore(dir, "work", "mine");
    store.save(baseline());
    const saved = JSON.parse(readFileSync(store.path, "utf8"));

    writeFileSync(store.path, JSON.stringify({ ...saved, version: 2 }));
    expect(store.load().reset).toMatch(/written by another version \(version\)/);

    store.save(baseline());
    saved.baseline.snapshot.schemaVersion = 0;
    writeFileSync(store.path, JSON.stringify(saved));
    expect(store.load().reset).toMatch(/written by another version/);
  });

  test("names the missing fields once when PRs were saved by an older version", () => {
    const store = new StateStore(dir, "work", "mine");
    store.save(baseline());
    const saved = JSON.parse(readFileSync(store.path, "utf8"));
    for (const pr of saved.baseline.snapshot.prs) {
      delete pr.mergeState;
      delete pr.pendingReviewers;
    }
    writeFileSync(store.path, JSON.stringify(saved));
    const result = store.load();
    expect(result.baseline).toBeNull();
    expect(result.reset).toMatch(
      /^state file was written by another version \((mergeState, pendingReviewers|pendingReviewers, mergeState)\); moved to /
    );
    expect(result.reset).not.toContain("\n");
    expect(result.reset!.length).toBeLessThan(250);
  });

  test("surfaces read errors that are not a missing file", () => {
    const store = new StateStore(dir, "work", "mine");
    mkdirSync(store.path, { recursive: true });
    expect(() => store.load()).toThrow(/EISDIR/);
  });

  test.each(["", "../evil", "a/b", " x", "-x", "x y", ".hidden"])("rejects the profile name %j", (name) => {
    expect(() => new StateStore(dir, name, "mine")).toThrow(/invalid profile name/);
  });

  test("allows only one running instance per profile and command", () => {
    const store = new StateStore(dir, "work", "mine");
    const lock = store.lock();
    expect(() => new StateStore(dir, "work", "mine").lock()).toThrow(LockError);
    expect(() => new StateStore(dir, "work", "todo").lock().release()).not.toThrow();
    lock.release();
    expect(() => store.lock().release()).not.toThrow();
  });

  test("lets the diff engine pick up where the last run left off", () => {
    const store = new StateStore(dir, "work", "mine");
    const snapshot = parseSnapshot(fixture("mine"));

    const first = computeEvents(store.load().baseline, snapshot);
    expect(first.events).toEqual([]);
    store.save(first.next);

    const again = computeEvents(store.load().baseline, snapshot);
    expect(again.events).toEqual([]);

    const changed = structuredClone(snapshot);
    changed.prs[0]!.reviews.push({
      id: "PRR_NEW",
      author: "carol",
      state: "APPROVED",
      submittedAt: "2026-10-13T11:00:00Z",
      commitOid: "abc",
    });
    const next = computeEvents(store.load().baseline, changed);
    expect(next.events.map((e) => e.kind)).toEqual(["review_approved"]);
  });

  test("repeats the same events when the run fails before saving", () => {
    const store = new StateStore(dir, "work", "mine");
    const snapshot = parseSnapshot(fixture("mine"));
    store.save(computeEvents(null, snapshot).next);

    const changed = structuredClone(snapshot);
    changed.prs[0]!.reviews.push({
      id: "PRR_NEW",
      author: "carol",
      state: "APPROVED",
      submittedAt: "2026-10-13T11:00:00Z",
      commitOid: "abc",
    });

    const attempt1 = computeEvents(store.load().baseline, changed);
    const attempt2 = computeEvents(store.load().baseline, changed);
    expect(attempt1.events).toHaveLength(1);
    expect(attempt2.events).toEqual(attempt1.events);
  });
});
