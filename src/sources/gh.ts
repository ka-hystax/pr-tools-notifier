import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSnapshot } from "../contract/snapshot.js";
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
  jiraRequired?: boolean;
  // gh-pr-tools prints a line on stderr when it cannot do something (a rejected Jira token); the exit code stays 0.
  onWarning?: (line: string) => void;
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

// Runs `gh pr-tools -p PROFILE <command> --json` (or a checkout's entry script) and validates the document.
export function ghSource({
  profile,
  prToolsPath,
  signal,
  timeoutMs = 120_000,
  exec = defaultExec,
  jiraRequired = false,
  onWarning,
}: GhOptions): SnapshotSource {
  const file = prToolsPath ?? "gh";
  const prefix = prToolsPath ? [] : ["pr-tools"];
  return async (command) => {
    const options: ExecOptions = { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" };
    if (signal) options.signal = signal;

    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await exec(file, [...prefix, "-p", profile, command, "--json"], options));
    } catch (err) {
      throw new Error(describeFailure(err, file, timeoutMs));
    }
    for (const line of stderr.split("\n")) if (line.trim() !== "") onWarning?.(line.trim());

    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      throw new Error("output is not valid JSON");
    }
    try {
      const snapshot = parseSnapshot(raw);
      if (snapshot.command !== command) throw new Error(`expected a ${command} snapshot, got ${snapshot.command}`);
      if (jiraRequired && snapshot.command === "mine" && snapshot.prs.some((pr) => pr.jira === undefined)) {
        throw new Error("gh-pr-tools does not report Jira tickets (needed for MERGE_STATUS)");
      }
      return snapshot;
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  };
}
