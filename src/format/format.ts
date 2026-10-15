import type { Thread } from "../contract/snapshot.js";
import type { MergeStatus, NotifyEvent, PrRef } from "../diff/diff.js";

export const MAX_MESSAGE_LENGTH = 4096;
const SUFFIX_RESERVE = 20;
const TITLE_MAX = 80;
const EXCERPT_MAX = 100; // about 3 lines of a quote on a phone, 2 on a half-width desktop window
const MAX_NAMES = 3;
const JOB_MAX = 40;
const LONG_GAP_MS = 30 * 60 * 1000;
const MAX_PR_BUTTONS = 6;
const BUTTONS_PER_ROW = 3;

export interface Button {
  text: string;
  url: string;
}

export interface OutMessage {
  text: string;
  buttons: Button[][];
  silent: boolean;
}

export interface FormatOptions {
  previousAt?: string;
  now?: string;
  timeZone?: string;
}

interface Line {
  text: string;
  url: string;
  events: NotifyEvent[];
}

interface Section {
  pr: PrRef;
  head: string;
  lines: Line[];
}

type ThreadEvent = Extract<NotifyEvent, { thread: Thread }>;
type Approved = Extract<NotifyEvent, { kind: "review_approved" }>;
type ChangesRequested = Extract<NotifyEvent, { kind: "review_changes_requested" }>;
type CiFailed = Extract<NotifyEvent, { kind: "ci_failed" }>;
type ReadyToMerge = Extract<NotifyEvent, { kind: "ready_to_merge" }>;
type MergeBlocked = Extract<NotifyEvent, { kind: "merge_blocked" }>;
type ReviewRequested = Extract<NotifyEvent, { kind: "review_requested" }>;

// Most urgent first within a PR.
const RANK: Record<NotifyEvent["kind"], number> = {
  review_requested: 0,
  ci_failed: 1,
  review_changes_requested: 2,
  thread_pending: 3,
  thread_answered: 4,
  ready_to_merge: 5,
  review_approved: 6,
  merge_blocked: 7,
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function clipWords(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${space > max * 0.6 ? head.slice(0, space) : head}…`;
}

function link(url: string, label: string): string {
  return `<a href="${escapeAttr(url)}">${label}</a>`;
}

function bold(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

function names(authors: string[]): string {
  const unique = [...new Set(authors)];
  return unique.slice(0, MAX_NAMES).map(bold).join(", ") + (unique.length > MAX_NAMES ? ` +${unique.length - MAX_NAMES}` : "");
}

function header(pr: PrRef): string {
  return `${link(pr.url, bold(`#${pr.number}`))} ${escapeHtml(clip(pr.title, TITLE_MAX))}`;
}

function quote(excerpt: string): string {
  return excerpt ? `\n<blockquote>${escapeHtml(clipWords(excerpt, EXCERPT_MAX))}</blockquote>` : "";
}

function comments(thread: Thread): string {
  return thread.commentCount > 1 ? ` · ${thread.commentCount} comments` : "";
}

const isThreadEvent = (e: NotifyEvent): e is ThreadEvent => "thread" in e;
const isApproved = (e: NotifyEvent): e is Approved => e.kind === "review_approved";
const isChangesRequested = (e: NotifyEvent): e is ChangesRequested => e.kind === "review_changes_requested";

// Bot threads and approvals below the threshold are worth seeing, not hearing.
const isLowPriority = (e: NotifyEvent): boolean =>
  (e.kind === "thread_pending" && e.thread.watched) || (e.kind === "review_approved" && e.approval.decision !== "approved");

// One author's threads of one kind on one PR; several collapse into a single linked count.
function threadLine(events: ThreadEvent[]): string {
  const first = events[0]!;
  const author = bold(first.thread.lastAuthor);
  const bot = events.every((e) => e.thread.watched);

  if (events.length === 1) {
    const { thread } = first;
    if (first.kind === "thread_answered") {
      return `↩️ ${author} ${link(thread.url, "replied")} in your thread${comments(thread)}${quote(thread.excerpt)}`;
    }
    const action = thread.commentCount > 1 ? "replied in a thread" : "opened a thread";
    return `${bot ? "🤖" : "💬"} ${author} ${link(thread.url, action)}${comments(thread)}${bot ? "" : quote(thread.excerpt)}`;
  }

  if (first.kind === "thread_answered") {
    return `↩️ ${author} replied in ${link(first.thread.url, `${events.length} of your threads`)}`;
  }
  const verb = events.every((e) => e.thread.commentCount === 1)
    ? "opened"
    : events.every((e) => e.thread.commentCount > 1)
      ? "replied in"
      : "commented in";
  return `${bot ? "🤖" : "💬"} ${author} ${verb} ${link(first.thread.url, `${events.length} threads`)}`;
}

function ciLine(event: CiFailed): Line {
  const url = `${event.pr.url}/checks`;
  const shown = event.failedJobs.slice(0, MAX_NAMES).map((job) => `<code>${escapeHtml(clip(job, JOB_MAX))}</code>`);
  const more = event.failedJobs.length > MAX_NAMES ? ` +${event.failedJobs.length - MAX_NAMES}` : "";
  return { text: `❌ ${link(url, "CI failed")}${shown.length ? ` · ${shown.join(", ")}${more}` : ""}`, url, events: [event] };
}

function requestedLine(event: ReviewRequested): Line {
  return { text: `🔔 Review requested · PR by ${bold(event.pr.author)}`, url: event.pr.url, events: [event] };
}

function waitingFor(reviewers: string[]): string {
  return reviewers.length > 0 ? `waiting for review from ${names(reviewers)}` : "a required review or check is missing";
}

function joinItems(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// The line that says whether an approved PR can be merged, and what to do first if it cannot.
function verdict(status: MergeStatus, prUrl: string): string | null {
  switch (status.kind) {
    case "unapproved":
      return null;
    case "ready":
      return "🎉 <b>Time to merge!</b>";
    case "waiting_ci":
      return "⏳ Waiting for CI to finish";
    case "github_blocked":
      return `🚧 GitHub blocks the merge: ${waitingFor(status.waitingFor)}`;
    case "todo": {
      const items: string[] = [];
      const { pendingThreads, firstPendingThreadUrl } = status;
      if (pendingThreads > 0 && firstPendingThreadUrl) {
        items.push(
          `resolve ${link(firstPendingThreadUrl, `${pendingThreads} ${pendingThreads === 1 ? "thread" : "threads"}`)}`
        );
      }
      if (status.ciFailed) items.push(`fix the ${link(`${prUrl}/checks`, "failing CI")}`);
      if (status.needsRebase) items.push("rebase the branch");
      return `🚧 Before merge ${joinItems(items)}`;
    }
  }
}

function approvalLine(events: Approved[]): string {
  const first = events[0]!;
  const { approvers, staleApprovers, threshold } = first.approval;
  const stale = staleApprovers.length > 0 ? ` (${staleApprovers.length} stale)` : "";
  const line = `✅ ${names(events.map((e) => e.review.author))} approved · ${approvers.length + staleApprovers.length}/${threshold}${stale}`;
  const third = verdict(first.status, first.pr.url);
  return third ? `${line}\n${third}` : line;
}

function readyLine(event: ReadyToMerge): Line {
  return { text: "🎉 <b>Time to merge!</b>", url: event.pr.url, events: [event] };
}

function blockedLine(event: MergeBlocked): Line {
  return {
    text: `🚧 All set, but GitHub blocks the merge: ${waitingFor(event.waitingFor)}`,
    url: event.pr.url,
    events: [event],
  };
}

function byAuthor(events: ThreadEvent[]): ThreadEvent[][] {
  const groups = new Map<string, ThreadEvent[]>();
  for (const e of events) groups.set(e.thread.lastAuthor, [...(groups.get(e.thread.lastAuthor) ?? []), e]);
  return [...groups.values()];
}

function when(event: NotifyEvent): string {
  return isThreadEvent(event) ? event.thread.lastCommentAt : "review" in event ? (event.review.submittedAt ?? "") : "";
}

function chronological(a: NotifyEvent, b: NotifyEvent): number {
  return when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0;
}

function standalone(event: NotifyEvent): Line[] {
  switch (event.kind) {
    case "ci_failed":
      return [ciLine(event)];
    case "review_requested":
      return [requestedLine(event)];
    case "ready_to_merge":
      return [readyLine(event)];
    case "merge_blocked":
      return [blockedLine(event)];
    default:
      return [];
  }
}

function lines(group: NotifyEvent[]): Line[] {
  const byKind = new Map<NotifyEvent["kind"], NotifyEvent[]>();
  for (const event of group) byKind.set(event.kind, [...(byKind.get(event.kind) ?? []), event]);
  return [...byKind.entries()]
    .sort(([a], [b]) => RANK[a] - RANK[b])
    .flatMap(([, events]): Line[] => {
      const sorted = events.sort(chronological);
      if (sorted.every(isThreadEvent)) {
        return byAuthor(sorted).map((g) => ({ text: threadLine(g), url: g[0]!.thread.url, events: g }));
      }
      if (sorted.every(isApproved)) return [{ text: approvalLine(sorted), url: sorted[0]!.pr.url, events: sorted }];
      if (sorted.every(isChangesRequested)) {
        return [
          { text: `🔄 ${names(sorted.map((e) => e.review.author))} requested changes`, url: sorted[0]!.pr.url, events: sorted },
        ];
      }
      return sorted.flatMap(standalone);
    });
}

function sinceLabel(previousAt: string, now: string, timeZone?: string): string {
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone, ...o });
  const prev = new Date(previousAt);
  const cur = new Date(now);
  const time = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(prev);
  const day = (d: Date) => fmt({ year: "numeric", month: "numeric", day: "numeric" }).format(d);
  if (day(prev) === day(cur)) return time;
  const days = (cur.getTime() - prev.getTime()) / 86_400_000;
  return days < 7
    ? `${fmt({ weekday: "short" }).format(prev)} ${time}`
    : `${fmt({ day: "numeric", month: "short" }).format(prev)} ${time}`;
}

// Only worth a header when a pause left several events behind.
function preface(events: NotifyEvent[], { previousAt, now, timeZone }: FormatOptions): string {
  if (!previousAt || !now || events.length < 2) return "";
  if (!(Date.parse(now) - Date.parse(previousAt) >= LONG_GAP_MS)) return "";
  return `🌅 <b>Since ${escapeHtml(sinceLabel(previousAt, now, timeZone))} — ${events.length} events</b>\n\n`;
}

function buttons(chunk: Section[]): Button[][] {
  if (chunk.length === 1) {
    const only = chunk[0]!;
    return [[{ text: "🔗 Open", url: only.lines.length === 1 ? only.lines[0]!.url : only.pr.url }]];
  }
  if (chunk.length > MAX_PR_BUTTONS) return [];
  const all = chunk.map((s) => ({ text: `🔗 #${s.pr.number}`, url: s.pr.url }));
  return Array.from({ length: Math.ceil(all.length / BUTTONS_PER_ROW) }, (_, i) =>
    all.slice(i * BUTTONS_PER_ROW, (i + 1) * BUTTONS_PER_ROW)
  );
}

// A message about one event leads with the event, so a lock-screen preview shows what happened first.
function render(chunk: Section[], lead: string, index: number, total: number): string {
  const single = lead === "" && chunk.length === 1 && chunk[0]!.lines.length === 1;
  const body = single
    ? `${chunk[0]!.lines[0]!.text}\n${chunk[0]!.head}`
    : chunk.map((s) => `${s.head}\n${s.lines.map((l) => l.text).join("\n")}`).join("\n\n");
  return `${lead}${body}${total > 1 ? `\n\n<i>${index + 1}/${total}</i>` : ""}`;
}

export function formatEvents(events: NotifyEvent[], options: FormatOptions = {}): OutMessage[] {
  const groups = new Map<string, NotifyEvent[]>();
  for (const event of events) {
    const key = `${event.pr.repo}#${event.pr.number}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  const lead = preface(events, options);
  const budget = MAX_MESSAGE_LENGTH - SUFFIX_RESERVE;
  const chunks: Section[][] = [];
  let current: Section[] = [];
  let size = lead.length;
  for (const group of groups.values()) {
    const pr = group[0]!.pr;
    const head = header(pr);
    for (const line of lines(group)) {
      const last = current.at(-1);
      const continuing = last !== undefined && last.pr.repo === pr.repo && last.pr.number === pr.number;
      const addition = continuing ? 1 + line.text.length : (current.length > 0 ? 2 : 0) + head.length + 1 + line.text.length;
      if (current.length > 0 && size + addition > budget) {
        chunks.push(current);
        current = [{ pr, head, lines: [line] }];
        size = head.length + 1 + line.text.length;
      } else if (continuing) {
        last.lines.push(line);
        size += addition;
      } else {
        current.push({ pr, head, lines: [line] });
        size += addition;
      }
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk, i) => ({
    text: render(chunk, i === 0 ? lead : "", i, chunks.length),
    buttons: buttons(chunk),
    silent: chunk.every((s) => s.lines.every((l) => l.events.every(isLowPriority))),
  }));
}
