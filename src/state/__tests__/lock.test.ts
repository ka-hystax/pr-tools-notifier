import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { acquireLock, activeLocks, LockError } from "../lock.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prn-lock-"));
  path = join(dir, "x.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

describe("acquireLock", () => {
  test("writes our pid and removes the file on release", () => {
    const lock = acquireLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  test("refuses a second holder and names the owner and the file", () => {
    const lock = acquireLock(path);
    expect(() => acquireLock(path)).toThrow(LockError);
    expect(() => acquireLock(path)).toThrow(new RegExp(`pid ${process.pid}.*${path}`));
    lock.release();
  });

  test("can be acquired again after release", () => {
    acquireLock(path).release();
    expect(() => acquireLock(path).release()).not.toThrow();
  });

  test("takes over a lock whose owner is gone", () => {
    writeFileSync(path, String(deadPid()));
    const lock = acquireLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
  });

  test("keeps a lock held by a live process", () => {
    writeFileSync(path, String(process.ppid));
    expect(() => acquireLock(path)).toThrow(LockError);
    expect(readFileSync(path, "utf8")).toBe(String(process.ppid));
  });

  test("treats a fresh lock with no readable pid as held, since its writer may be mid-write", () => {
    writeFileSync(path, "");
    expect(() => acquireLock(path)).toThrow(LockError);
  });

  test("takes over an old lock with garbage in it", () => {
    writeFileSync(path, "garbage");
    const past = new Date(Date.now() - 60_000);
    utimesSync(path, past, past);
    const lock = acquireLock(path);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
    lock.release();
  });

  test("makes release idempotent and never removes a lock someone else now owns", () => {
    const lock = acquireLock(path);
    lock.release();
    writeFileSync(path, String(process.ppid));
    lock.release();
    expect(readFileSync(path, "utf8")).toBe(String(process.ppid));
  });

  test("surfaces unexpected filesystem errors", () => {
    expect(() => acquireLock(join(dir, "missing", "x.lock"))).toThrow(/ENOENT/);
  });
});

describe("activeLocks", () => {
  test("lists only locks held by a live process", () => {
    const live = join(dir, "live.lock");
    writeFileSync(live, String(process.pid));
    writeFileSync(join(dir, "dead.lock"), String(deadPid()));
    writeFileSync(join(dir, "state.json"), String(process.pid));
    expect(activeLocks(dir)).toEqual([live]);
  });

  test("is empty for a missing directory", () => {
    expect(activeLocks(join(dir, "missing"))).toEqual([]);
  });
});
