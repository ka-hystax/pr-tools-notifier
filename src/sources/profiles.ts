import { defaultExec, describeFailure, type Exec } from "./gh.js";

export interface ProfileOptions {
  profile?: string;
  prToolsPath?: string;
  signal?: AbortSignal;
  exec?: Exec;
  timeoutMs?: number;
}

export class ProfileError extends Error {}

// `gh pr-tools profile list` prints one name per line, marking the checkout's own with "(cwd)".
export function parseProfileList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("("))
    .map((line) => line.split(/\s+/)[0]!);
}

// The profile to poll: the one named, or the only one there is.
export async function resolveProfile({
  profile,
  prToolsPath,
  signal,
  exec = defaultExec,
  timeoutMs = 30_000,
}: ProfileOptions): Promise<string> {
  if (profile) return profile;

  const file = prToolsPath ?? "gh";
  const args = [...(prToolsPath ? [] : ["pr-tools"]), "profile", "list"];
  let stdout: string;
  try {
    ({ stdout } = await exec(file, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      ...(signal ? { signal } : {}),
    }));
  } catch (err) {
    throw new ProfileError(
      `could not list the gh-pr-tools profiles (${describeFailure(err, file, timeoutMs)}); name one with -p`
    );
  }

  const names = parseProfileList(stdout);
  if (names.length === 1) return names[0]!;
  if (names.length === 0) throw new ProfileError("there is no gh-pr-tools profile yet: run `gh pr-tools init`, then try again");
  throw new ProfileError(`there are several gh-pr-tools profiles (${names.join(", ")}): choose one with -p NAME`);
}
