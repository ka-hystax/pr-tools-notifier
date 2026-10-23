import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../utils/fs.js";

const BotStateFile = z.object({
  intro: z.boolean(),
  // Messages the bot keeps on screen, so a restart can take them down.
  view: z.array(z.number().int()),
});

export type BotState = z.infer<typeof BotStateFile>;

// What the bot remembers between runs: whether it has introduced itself, and which answer is on screen.
export class BotStateStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "bot.json");
  }

  load(): BotState {
    try {
      const parsed = BotStateFile.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // missing or unreadable: start over
    }
    return { intro: false, view: [] };
  }

  save(state: BotState): void {
    writeFileAtomic(this.path, JSON.stringify(state));
  }
}
