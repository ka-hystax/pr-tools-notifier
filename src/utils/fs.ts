import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Temp file in the same directory, fsync, rename: readers see the old file or the new one, never half of it.
export function writeFileAtomic(path: string, data: string): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
