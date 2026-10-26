import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "../utils/errors.js";
import { writeFileAtomic } from "../utils/fs.js";

// One line of the list: a PR by number or link, or a Jira ticket (all of its PRs).
export type TrackedEntry = { kind: "pr"; number: number; text: string } | { kind: "ticket"; key: string; text: string };

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TICKET = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PR_LINK = /[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)/;
const MAX_PR = 2_147_483_647;
const HEADER = `# PRs and Jira tickets pr-tools-notifier follows, one per line: 1281, a PR link, PRJ-1824 or a Jira link.
# A ticket stands for every PR whose title names it. "#" starts a comment, except in "#1281".
`;

// A ticket key, or the ticket of a Jira link (a browse link's last segment, a board link's selectedIssue).
function ticketOf(text: string): string | null {
  let key = text;
  if (/^https?:\/\//i.test(text)) {
    const selected = /[?&]selectedIssue=([^&#]+)/.exec(text);
    key = selected ? selected[1]! : (text.split(/[?#]/)[0]!.replace(/\/+$/, "").split("/").at(-1) ?? "");
  }
  return TICKET.test(key) ? key.toUpperCase() : null;
}

// What `gh pr-tools track` takes, in the form it is stored: "1281", a PR link as given, or "PRJ-1824".
export function parseRef(input: string): TrackedEntry | null {
  const text = input.trim();
  const bare = text.replace(/^#/, "");
  if (/^\d+$/.test(bare)) {
    const number = Number(bare);
    return number > 0 && number <= MAX_PR ? { kind: "pr", number, text: String(number) } : null;
  }
  const link = /^https?:\/\//i.test(text) ? PR_LINK.exec(text) : null;
  if (link) {
    const number = Number(link[1]);
    return number > 0 && number <= MAX_PR ? { kind: "pr", number, text } : null;
  }
  const key = ticketOf(bare);
  return key ? { kind: "ticket", key, text: key } : null;
}

export function sameEntry(a: TrackedEntry, b: TrackedEntry): boolean {
  return a.kind === "pr" ? b.kind === "pr" && a.number === b.number : b.kind === "ticket" && a.key === b.key;
}

export function entryLabel(entry: TrackedEntry): string {
  return entry.kind === "pr" ? `#${entry.number}` : entry.key;
}

// A line's reference, read the way gh-pr-tools reads a --list file: trimmed, "#" comments, "#1281" kept.
function lineRef(line: string): string | null {
  const trimmed = line.replace(/\r$/, "").trim();
  if (trimmed === "" || (trimmed.startsWith("#") && !/^#\d/.test(trimmed))) return null;
  return trimmed.replace(/\s+#.*$/, "").trim();
}

export interface TrackedRead {
  entries: TrackedEntry[];
  invalid: string[]; // lines gh-pr-tools would skip
}

// The list `run` passes to `gh pr-tools track --list`, one per profile since PR numbers belong to a repo.
// It can be edited by hand, with `pr-tools-notifier track` or from the bot; every poll reads it again.
export class TrackedList {
  readonly path: string;

  constructor(dir: string, profile: string) {
    if (!PROFILE_NAME.test(profile)) throw new Error(`invalid profile name '${profile}' (use letters, digits, _, -)`);
    this.path = join(dir, "tracked", `${profile}.txt`);
  }

  private lines(): string[] {
    try {
      return readFileSync(this.path, "utf8").replace(/^﻿/, "").split("\n");
    } catch (err) {
      if (errorCode(err) === "ENOENT") return [];
      throw err;
    }
  }

  read(): TrackedRead {
    const entries: TrackedEntry[] = [];
    const invalid: string[] = [];
    for (const line of this.lines()) {
      const ref = lineRef(line);
      if (ref === null) continue;
      const entry = parseRef(ref);
      if (!entry) invalid.push(ref);
      else if (!entries.some((e) => sameEntry(e, entry))) entries.push(entry);
    }
    return { entries, invalid };
  }

  // Appends what is new, in the order given; the rest of the file stays as it was.
  add(inputs: string[]): { added: TrackedEntry[]; already: TrackedEntry[]; invalid: string[] } {
    const current = this.read().entries;
    const added: TrackedEntry[] = [];
    const already: TrackedEntry[] = [];
    const invalid: string[] = [];
    for (const input of inputs) {
      const entry = parseRef(input);
      if (!entry) invalid.push(input.trim());
      else if ([...current, ...added].some((e) => sameEntry(e, entry))) already.push(entry);
      else added.push(entry);
    }
    if (added.length > 0) {
      const lines = this.lines();
      const old = lines.join("\n").trim();
      const text = old === "" ? HEADER : `${old}\n`;
      writeFileAtomic(this.path, `${text}${added.map((e) => e.text).join("\n")}\n`);
    }
    return { added, already, invalid };
  }

  // Drops every line that names one of the entries; comments and other lines stay.
  remove(entries: TrackedEntry[]): TrackedEntry[] {
    const lines = this.lines();
    const removed: TrackedEntry[] = [];
    const kept = lines.filter((line) => {
      const ref = lineRef(line);
      const entry = ref === null ? null : parseRef(ref);
      const match = entry !== null && entries.some((e) => sameEntry(e, entry));
      if (match && !removed.some((e) => sameEntry(e, entry))) removed.push(entry);
      return !match;
    });
    if (removed.length > 0) writeFileAtomic(this.path, kept.join("\n"));
    return removed;
  }
}
