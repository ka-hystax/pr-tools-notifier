import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseSnapshot, type TrackSnapshot } from "../contract/snapshot.js";
import { errorMessage, type SnapshotSource } from "../runner/types.js";

export interface ExecOptions {
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  signal?: AbortSignal;
}

export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<{ stdout: string; stderr: string }>;

export interface GhOptions {
  profile: string;
  prToolsPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  exec?: Exec;
  // `mine` must report the ticket of each PR: a gh-pr-tools that does not is too old for the Jira merge status.
  jiraRequired?: boolean | (() => boolean);
  // gh-pr-tools prints a line on stderr when it cannot do something (a rejected Jira token); the exit code stays 0.
  onWarning?: (line: string) => void;
  // `track` reads its PRs and tickets from this list file; a list naming tickets needs a gh-pr-tools that takes them.
  track?: { listPath: string; hasTickets: () => boolean };
}

export const defaultExec = promisify(execFile) as unknown as Exec;

interface ExecFailure {
  code?: string | number;
  name?: string;
  killed?: boolean;
  stderr?: string;
}

export function describeFailure(err: unknown, file: string, timeoutMs: number): string {
  const e = err as ExecFailure;
  if (e.code === "ENOENT") return `${file} was not found in PATH`;
  if (e.name === "AbortError") return "aborted";
  if (e.killed) return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  const tail = (e.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
  return `exited with ${e.code ?? "an error"}${tail ? `: ${tail}` : ""}`;
}

// Runs `gh pr-tools -p PROFILE <command> --json [args]` (or a checkout's entry script) and returns the document.
async function runJson(
  { profile, prToolsPath, signal, timeoutMs = 120_000, exec = defaultExec, onWarning }: GhOptions,
  command: string,
  args: string[]
): Promise<unknown> {
  const file = prToolsPath ?? "gh";
  const prefix = prToolsPath ? [] : ["pr-tools"];
  const options: ExecOptions = { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" };
  if (signal) options.signal = signal;

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await exec(file, [...prefix, "-p", profile, command, "--json", ...args], options));
  } catch (err) {
    throw new Error(describeFailure(err, file, timeoutMs));
  }
  for (const line of stderr.split("\n")) if (line.trim() !== "") onWarning?.(line.trim());
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("output is not valid JSON");
  }
}

// Validated snapshots of `gh pr-tools -p PROFILE <command> --json`.
export function ghSource(options: GhOptions): SnapshotSource {
  const { jiraRequired = false, track } = options;
  return async (command) => {
    const raw = await runJson(options, command, command === "track" && track ? ["--list", track.listPath] : []);
    try {
      const snapshot = parseSnapshot(raw);
      if (snapshot.command !== command) throw new Error(`expected a ${command} snapshot, got ${snapshot.command}`);
      const needsJira = typeof jiraRequired === "function" ? jiraRequired() : jiraRequired;
      if (needsJira && snapshot.command === "mine" && snapshot.prs.some((pr) => pr.jira === undefined)) {
        throw new Error("gh-pr-tools does not report Jira tickets (needed for MERGE_STATUS)");
      }
      if (snapshot.command === "track" && snapshot.tickets === undefined && track?.hasTickets()) {
        throw new Error("gh-pr-tools track does not take Jira tickets (the tracked list names some)");
      }
      return snapshot;
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  };
}

// Asks `track` about references without following them; one the profile cannot take is left out of the answer.
export function ghTrackProbe(options: Omit<GhOptions, "onWarning" | "track" | "jiraRequired">) {
  return async (refs: string[]): Promise<TrackSnapshot> => {
    const dir = mkdtempSync(join(tmpdir(), "prn-probe-"));
    try {
      const list = join(dir, "list.txt");
      writeFileSync(list, `${refs.join("\n")}\n`);
      const snapshot = parseSnapshot(await runJson(options, "track", ["--list", list]));
      if (snapshot.command !== "track") throw new Error(`expected a track snapshot, got ${snapshot.command}`);
      return snapshot;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
