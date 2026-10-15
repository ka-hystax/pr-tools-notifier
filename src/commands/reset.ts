import { existsSync, rmSync } from "node:fs";
import type { Prompter } from "./init.js";

export interface ResetDeps {
  prompter: Pick<Prompter, "confirm">;
  dir: string;
  yes: boolean;
  out: (line: string) => void;
  activeLocks: () => string[];
  remove?: (dir: string) => void;
}

// Resolves to whether the state is gone (or was never there).
export async function runReset({ prompter, dir, yes, out, activeLocks, remove }: ResetDeps): Promise<boolean> {
  if (!existsSync(dir)) {
    out(`Nothing to remove: ${dir} does not exist.`);
    return true;
  }
  if (activeLocks().length > 0) {
    out("`pr-tools-notifier run` is still running; stop it first.");
    return false;
  }
  if (!yes && !(await prompter.confirm(`Delete ${dir} (the bot token, its key and the saved state)?`))) {
    out("Nothing changed.");
    return false;
  }

  (remove ?? ((path) => rmSync(path, { recursive: true, force: true })))(dir);
  out(`Removed ${dir}.`);
  out("The bot itself is still in Telegram: send /deletebot (or /revoke for the token only) to @BotFather.");
  out("gh-pr-tools settings were not touched.");
  return true;
}
