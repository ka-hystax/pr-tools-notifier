import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "pr-tools-notifier");
}

export function stateDir(env: Env = process.env, home: string = homedir()): string {
  return join(configDir(env, home), "state");
}
