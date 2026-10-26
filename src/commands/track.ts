import { entryLabel, parseRef, type TrackedEntry, type TrackedList } from "../config/tracked.js";

export type TrackAction = { type: "show" } | { type: "add" | "rm"; refs: string[] };

const NOT_A_REF = "is not a PR number, a PR link or a Jira ticket";
const PICKED_UP = "A running `pr-tools-notifier run` picks it up on its next poll.";

function show(list: TrackedList, out: (line: string) => void): boolean {
  const { entries, invalid } = list.read();
  if (entries.length === 0 && invalid.length === 0) {
    out("Nothing is tracked yet. Add PRs or Jira tickets: pr-tools-notifier track add 1281 PRJ-1824");
    return true;
  }
  out(`Tracked list: ${list.path}`);
  for (const entry of entries)
    out(`  ${entry.kind === "ticket" ? `${entry.key} (every PR of the ticket)` : entryLabel(entry)}`);
  for (const line of invalid) out(`  ${line} — ${NOT_A_REF}; gh-pr-tools skips it`);
  return true;
}

// Resolves to whether every reference was understood; the ones that were are applied anyway.
export function runTrack(list: TrackedList, action: TrackAction, out: (line: string) => void): boolean {
  if (action.type === "show") return show(list, out);

  if (action.type === "add") {
    const { added, already, invalid } = list.add(action.refs);
    if (added.length > 0) out(`Tracking ${added.map(entryLabel).join(", ")}. ${PICKED_UP}`);
    if (already.length > 0) out(`Already tracked: ${already.map(entryLabel).join(", ")}.`);
    for (const ref of invalid) out(`'${ref}' ${NOT_A_REF}.`);
    return invalid.length === 0;
  }

  const wanted: TrackedEntry[] = [];
  const invalid: string[] = [];
  for (const ref of action.refs) {
    const entry = parseRef(ref);
    if (entry) wanted.push(entry);
    else invalid.push(ref.trim());
  }
  const removed = list.remove(wanted);
  const missing = wanted.filter((w) => !removed.some((r) => entryLabel(r) === entryLabel(w)));
  if (removed.length > 0) out(`No longer tracking ${removed.map(entryLabel).join(", ")}. ${PICKED_UP}`);
  if (missing.length > 0) out(`Not tracked: ${missing.map(entryLabel).join(", ")}.`);
  for (const ref of invalid) out(`'${ref}' ${NOT_A_REF}.`);
  return invalid.length === 0;
}
