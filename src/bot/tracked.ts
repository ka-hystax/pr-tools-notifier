import type { TrackPullRequest, TrackSnapshot, TrackTicket } from "../contract/snapshot.js";
import { entryLabel, type TrackedEntry } from "../config/tracked.js";
import { trackedPassed } from "../diff/diff.js";
import { approvalCount, bold, clip, escapeHtml, italic, link, names } from "../format/format.js";
import { ago, earliest, paginate, plural, profileHeading, time } from "./views.js";

const TITLE_MAX = 60;

export interface TrackedOptions {
  now: Date;
  timeZone?: string;
  note?: string;
}

// One profile's list and its last poll; the profile is named when a run polls several.
export interface TrackedPart {
  profile?: string;
  entries: TrackedEntry[];
  snapshot: TrackSnapshot | null;
}

// What a ticket shows: its open PRs, else the last one merged. A PR closed without merging was replaced or dropped.
export function shownPrs(ticket: TrackTicket, prs: Map<number, TrackPullRequest>): TrackPullRequest[] {
  const all = ticket.prs.flatMap((n) => prs.get(n) ?? []);
  const open = all.filter((p) => p.state === "open");
  if (open.length > 0) return open;
  const merged = all.filter((p) => p.state === "merged").sort((a, b) => ((a.closedAt ?? "") < (b.closedAt ?? "") ? -1 : 1));
  return merged.slice(-1);
}

// Done: a PR that merged or closed, a ticket whose PRs all did. A ticket with no PR yet is still to come.
export function isDone(entry: TrackedEntry, snapshot: TrackSnapshot): boolean {
  const prs = new Map(snapshot.prs.map((p) => [p.number, p]));
  if (entry.kind === "pr") {
    const pr = prs.get(entry.number);
    return pr !== undefined && pr.state !== "open";
  }
  const ticket = snapshot.tickets?.find((t) => t.key === entry.key);
  const own = ticket?.prs.flatMap((n) => prs.get(n) ?? []) ?? [];
  return own.length > 0 && own.every((p) => p.state !== "open");
}

function title(pr: TrackPullRequest): string {
  return `${link(pr.url, bold(`#${pr.number}`))} ${escapeHtml(clip(pr.title, TITLE_MAX))} · ${escapeHtml(pr.author)}`;
}

// Where someone else's PR stands, for a person waiting on it rather than working on it.
function prRow(pr: TrackPullRequest, options: TrackedOptions, withTicket: boolean): string {
  if (pr.state !== "open") {
    const when = pr.closedAt ? ` ${ago(pr.closedAt, options.now)} ago` : "";
    return `${title(pr)}\n${pr.state === "merged" ? `🟣 merged${when}` : `✖️ closed${when}`}`;
  }
  const items: string[] = [];
  const pending = (pr.threads ?? []).filter((t) => t.state === "pending");
  if (pr.isDraft) items.push("📝 draft");
  else if (trackedPassed(pr)) items.push("✅ review passed");
  else if (pr.approval.changesRequestedBy.length > 0)
    items.push(`🔄 changes requested by ${names(pr.approval.changesRequestedBy)}`);
  else items.push(pr.pendingReviewers.length > 0 ? `⏳ review from ${names(pr.pendingReviewers)}` : "⏳ needs approvals");
  if (pending.length > 0) items.push(`💬 ${link(earliest(pending)?.url ?? pr.url, plural(pending.length, "open thread"))}`);
  if (pr.ci.state === "fail") items.push(`❌ ${link(`${pr.url}/checks`, "CI failed")}`);
  if (pr.ci.state === "pending") items.push("⏳ CI running");
  if (pr.mergeState === "dirty") items.push("🔀 conflicts");
  if (pr.mergeState === "behind") items.push("🔀 needs a rebase");
  items.push(approvalCount(pr.approval));
  if (withTicket && pr.jira?.status) {
    items.push(`🎫 ${pr.jira.url ? link(pr.jira.url, escapeHtml(pr.jira.status)) : escapeHtml(pr.jira.status)}`);
  }
  items.push(ago(pr.createdAt, options.now));
  return `${title(pr)}\n${items.join(" · ")}`;
}

function ticketHead(ticket: TrackTicket): string {
  const key = ticket.url ? link(ticket.url, bold(ticket.key)) : bold(ticket.key);
  return `🎫 ${key}${ticket.status ? ` · ${italic(ticket.status)}` : ""}`;
}

// One section per entry of the list, in the list's order.
function section(entry: TrackedEntry, snapshot: TrackSnapshot | null, options: TrackedOptions): string {
  const prs = new Map((snapshot?.prs ?? []).map((p) => [p.number, p]));
  if (entry.kind === "pr") {
    const pr = prs.get(entry.number);
    if (pr) return prRow(pr, options, true);
    return `${bold(entryLabel(entry))}\n⚠️ ${snapshot ? "not in the repo (or not loaded yet)" : "not loaded yet"}`;
  }
  const ticket = snapshot?.tickets?.find((t) => t.key === entry.key);
  if (!ticket) {
    const why = !snapshot
      ? "not loaded yet"
      : snapshot.tickets
        ? "skipped by gh-pr-tools (another Jira prefix?)"
        : "this gh-pr-tools does not take tickets";
    return `🎫 ${bold(entry.key)}\n⚠️ ${why}`;
  }
  const shown = shownPrs(ticket, prs);
  if (shown.length === 0)
    return `${ticketHead(ticket)}\n${italic(ticket.prs.length > 0 ? "its PRs were closed without merging" : "no PR yet")}`;
  return `${ticketHead(ticket)}\n${shown.map((p) => prRow(p, options, false)).join("\n")}`;
}

// One message text per page of the tracked list. The snapshot may be missing (never polled, and fetching failed).
export function renderTracked(entries: TrackedEntry[], snapshot: TrackSnapshot | null, options: TrackedOptions): string[] {
  return renderTrackedParts([{ entries, snapshot }], options);
}

// The same for several profiles, one section each; a profile that follows nothing is left out.
export function renderTrackedParts(parts: TrackedPart[], options: TrackedOptions): string[] {
  const heading = bold("📌 Tracked");
  const note = options.note ? `\n\n${options.note}` : "";
  const total = parts.reduce((sum, part) => sum + part.entries.length, 0);
  if (total === 0) {
    return [
      `${heading}\n\n📭 Nothing tracked yet. Send ${bold("/track")} with PR numbers or Jira tickets, for example <code>/track PRJ-1824 1281</code>, or tap ➕.${note}`,
    ];
  }
  const generatedAt = parts.flatMap((p) => (p.snapshot ? [p.snapshot.generatedAt] : [])).sort()[0];
  const when = generatedAt ? ` · ${time(new Date(generatedAt), options.timeZone)}` : "";
  const lines = parts.flatMap((part) =>
    part.entries.map((entry, i) => ({ profile: part.profile, first: i === 0, text: section(entry, part.snapshot, options) }))
  );
  const pages = paginate(lines);
  return pages.map((page, i) => {
    const paging = pages.length > 1 ? ` · ${i + 1}/${pages.length}` : "";
    const body = page.map((line, j) => {
      if (line.profile === undefined || !(line.first || j === 0)) return line.text;
      const head = `${profileHeading(line.profile)}${line.first ? "" : ` ${italic("(continued)")}`}`;
      return `${j > 0 ? "\n" : ""}${head}\n${line.text}`;
    });
    return `${heading} · ${total}${when}${paging}\n\n${body.join("\n\n")}${note}`;
  });
}
