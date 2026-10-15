import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { errorCode } from "../utils/errors.js";

const UNKNOWN_OWNER_GRACE_MS = 5_000;

export class LockError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number | null
  ) {
    super(`already running${pid === null ? "" : ` (pid ${pid})`}; if it is not, delete ${path}`);
  }
}

export interface Lock {
  release(): void;
}

function readPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

// A lock file with no readable pid may be a writer caught mid-write, so it only goes stale after a grace period.
function isStale(path: string): boolean {
  const pid = readPid(path);
  if (pid !== null) return !isAlive(pid);
  try {
    return Date.now() - statSync(path).mtimeMs > UNKNOWN_OWNER_GRACE_MS;
  } catch {
    return true;
  }
}

export function acquireLock(path: string): Lock {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          if (readPid(path) !== process.pid) return;
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      if (!isStale(path)) throw new LockError(path, readPid(path));
      try {
        unlinkSync(path);
      } catch {
        // someone else cleaned it up first
      }
    }
  }
  throw new LockError(path, readPid(path));
}
