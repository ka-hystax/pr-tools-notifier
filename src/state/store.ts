import { readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDir, writeFileAtomic } from "../utils/fs.js";
import { SnapshotSchema, type Snapshot } from "../contract/snapshot.js";
import type { Baseline } from "../diff/diff.js";
import { errorCode } from "../utils/errors.js";
import { acquireLock, type Lock } from "./lock.js";

const FILE_VERSION = 1;
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const StateFile = z.object({
  version: z.literal(FILE_VERSION),
  savedAt: z.iso.datetime(),
  baseline: z.object({
    snapshot: SnapshotSchema,
    missingTicks: z.record(z.string().regex(/^\d+$/), z.number().int().positive()),
  }),
});

export interface LoadResult {
  baseline: Baseline | null;
  reset?: string;
}

// One line naming the fields that differ, however many PRs repeat the same mistake.
function describeMismatch(error: z.ZodError): string {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    const name = [...issue.path].reverse().find((part) => typeof part === "string");
    if (typeof name === "string") fields.add(name);
  }
  const shown = [...fields].slice(0, 5).join(", ") + (fields.size > 5 ? ", …" : "");
  return `state file was written by another version (${shown})`;
}

export class StateStore {
  readonly path: string;

  constructor(
    readonly dir: string,
    profile: string,
    command: Snapshot["command"]
  ) {
    if (!PROFILE_NAME.test(profile)) throw new Error(`invalid profile name '${profile}' (use letters, digits, _, -)`);
    this.path = join(dir, `${profile}-${command}.json`);
  }

  lock(): Lock {
    ensurePrivateDir(this.dir);
    return acquireLock(`${this.path}.lock`);
  }

  // No file means a first run. An unreadable one is set aside and reported, and the run starts fresh.
  load(): LoadResult {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if (errorCode(err) === "ENOENT") return { baseline: null };
      throw err;
    }

    let reason: string;
    try {
      const parsed = StateFile.safeParse(JSON.parse(raw));
      if (parsed.success) return { baseline: parsed.data.baseline };
      reason = describeMismatch(parsed.error);
    } catch {
      reason = "state file is not valid JSON";
    }
    renameSync(this.path, `${this.path}.corrupt`);
    return { baseline: null, reset: `${reason}; moved to ${this.path}.corrupt` };
  }

  save(baseline: Baseline): void {
    writeFileAtomic(this.path, JSON.stringify({ version: FILE_VERSION, savedAt: new Date().toISOString(), baseline }));
  }
}

export interface StateInfo {
  profile: string;
  command: Snapshot["command"];
  path: string;
  // null when the file cannot be read by this version; a run would set it aside.
  prs: number | null;
  savedAt: string | null;
}

// Read-only: unlike `load`, never moves a file aside.
export function describeStates(dir: string): StateInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const infos: StateInfo[] = [];
  for (const name of names.sort()) {
    const match = /^(.+)-(mine|todo)\.json$/.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    const info: StateInfo = { profile: match[1]!, command: match[2] as Snapshot["command"], path, prs: null, savedAt: null };
    try {
      const parsed = StateFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        info.prs = parsed.data.baseline.snapshot.prs.length;
        info.savedAt = parsed.data.savedAt;
      }
    } catch {
      // unreadable: reported as such
    }
    infos.push(info);
  }
  return infos;
}
