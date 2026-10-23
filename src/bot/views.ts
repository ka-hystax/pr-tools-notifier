import type { MineSnapshot, Thread, TodoSnapshot } from "../contract/snapshot.js";
import { holdFor, mergeStatus, type MergeGate } from "../diff/diff.js";
import { approvalCount, bold, clip, escapeHtml, italic, link, names } from "../format/format.js";

const TITLE_MAX = 60;
const PAGE_BUDGET = 3_800;
const HEADER_RESERVE = 120;

export interface ListOptions {
  now: Date;
  timeZone?: string;
  gate?: MergeGate;
  // Shown under the list, for example that a refresh failed and the data is older.
  note?: string;
}

interface Row {
  rank: number;
  createdAt: string;
  text: string;
  // False for what only waits for other people: shown below a divider, so the rows that need you stand out.
  yours: boolean;
}

// "5m", "3h", "4d": how long ago, in the biggest unit that is at least one.
export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function earliest(threads: Thread[]): Thread | undefined {
  return [...threads].sort((a, b) => (a.lastCommentAt < b.lastCommentAt ? -1 : a.lastCommentAt > b.lastCommentAt ? 1 : 0))[0];
}

function head(emoji: string, pr: { number: number; url: string; title: string }): string {
  return `${emoji} ${link(pr.url, bold(`#${pr.number}`))} ${escapeHtml(clip(pr.title, TITLE_MAX))}`;
}

function or(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

// Ranks, most actionable first: ready to merge, then what needs fixing, then what waits for others.
const READY = 0;
const BROKEN = 1;
const FIX = 2;
const BLOCKED = 3;
const WAITING = 4;
const PARKED = 5;

function mineRow(pr: MineSnapshot["prs"][number], options: ListOptions): Row {
  const pending = (pr.threads ?? []).filter((t) => t.state === "pending");
  const first = earliest(pending);
  const changes = pr.approval.changesRequestedBy;
  const ciFailed = pr.ci.state === "fail";
  const rebase = pr.mergeState === "dirty" || pr.mergeState === "behind";

  const todo: string[] = [];
  if (changes.length > 0) todo.push(`changes requested by ${names(changes)}`);
  if (ciFailed) todo.push(link(`${pr.url}/checks`, "CI failed"));
  if (pending.length > 0) todo.push(link(first?.url ?? pr.url, plural(pending.length, "thread")));
  if (rebase) todo.push("needs a rebase");

  let emoji: string;
  let rank: number;
  let parts: string[];
  if (todo.length > 0) {
    [emoji, rank] = changes.length > 0 || ciFailed ? ["🔴", BROKEN] : ["🟠", FIX];
    parts = todo;
  } else if (pr.isDraft) {
    [emoji, rank, parts] = ["📝", PARKED, ["draft"]];
  } else if (pr.approval.decision === "awaiting") {
    [emoji, rank] = ["⏳", WAITING];
    parts = [pr.pendingReviewers.length > 0 ? `waiting for ${names(pr.pendingReviewers)}` : "needs approval"];
  } else {
    const status = mergeStatus(pr, pr.threads, holdFor(pr, options.gate));
    switch (status.kind) {
      case "ready":
        [emoji, rank, parts] = ["🟢", READY, ["ready to merge"]];
        break;
      case "github_blocked":
        [emoji, rank] = ["🚧", BLOCKED];
        parts = [`GitHub blocks the merge${status.waitingFor.length > 0 ? `: waiting for ${names(status.waitingFor)}` : ""}`];
        break;
      case "waiting_jira": {
        const now = status.ticket.status === null ? "Jira status unavailable" : `now: ${italic(status.ticket.status)}`;
        [emoji, rank] = ["🟣", PARKED];
        parts = [`review passed · waiting for ${or(status.wanted.map(italic))} (${now})`];
        break;
      }
      case "checking":
        [emoji, rank, parts] = ["⏳", WAITING, ["GitHub is checking the branch"]];
        break;
      default:
        [emoji, rank, parts] = ["⏳", WAITING, ["CI is running"]];
    }
  }

  const info = [approvalCount(pr.approval)];
  if (pr.jira?.status)
    info.push(`🎫 ${pr.jira.url ? link(pr.jira.url, escapeHtml(pr.jira.status)) : escapeHtml(pr.jira.status)}`);
  info.push(ago(pr.createdAt, options.now));
  return {
    rank,
    createdAt: pr.createdAt,
    yours: rank <= BLOCKED,
    text: `${head(emoji, pr)}\n${[...parts, ...info].join(" · ")}`,
  };
}

function todoRow(pr: TodoSnapshot["prs"][number], viewer: string, options: ListOptions): Row {
  const threads = pr.threads ?? [];
  const replies = threads.filter((t) => t.state === "answered" && t.lastAuthor !== viewer);
  const open = threads.filter((t) => t.state === "pending");

  const parts: string[] = [];
  if (pr.requestedFromMe) parts.push("review requested");
  if (replies.length > 0) {
    parts.push(link(earliest(replies)?.url ?? pr.url, `${plural(replies.length, "reply", "replies")} in your threads`));
  }
  let emoji = pr.requestedFromMe ? "🔔" : "↩️";
  let rank = pr.requestedFromMe ? READY : BROKEN;
  if (parts.length === 0) {
    [emoji, rank] = ["👀", WAITING];
    parts.push(open.length > 0 ? `waiting for the author on ${plural(open.length, "thread")}` : "you reviewed");
  }
  const info = [`by ${escapeHtml(pr.author)}`, approvalCount(pr.approval), ago(pr.createdAt, options.now)];
  return {
    rank,
    createdAt: pr.createdAt,
    yours: rank < WAITING,
    text: `${head(emoji, pr)}\n${[...parts, ...info].join(" · ")}`,
  };
}

function time(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

// Most actionable first. When both kinds are there, a line marks where the rows that only wait begin.
function ordered(rows: Row[]): string[] {
  const sorted = [...rows].sort(
    (a, b) => a.rank - b.rank || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
  );
  const waiting = sorted.filter((r) => !r.yours).length;
  const divide = waiting > 0 && waiting < sorted.length;
  let divided = false;
  return sorted.map((row) => {
    if (!divide || row.yours || divided) return row.text;
    divided = true;
    return `${italic(`Waiting on others · ${waiting}`)}\n\n${row.text}`;
  });
}

// Greedy pages that each fit in one message, whatever the number of PRs.
function paginate(rows: string[]): string[][] {
  const pages: string[][] = [[]];
  let size = 0;
  for (const row of rows) {
    const cost = row.length + 2;
    if (size + cost > PAGE_BUDGET - HEADER_RESERVE && pages.at(-1)!.length > 0) {
      pages.push([]);
      size = 0;
    }
    pages.at(-1)!.push(row);
    size += cost;
  }
  return pages;
}

// One message text per page of `mine` or `todo`, from a snapshot (the saved one or a fresh one).
export function renderList(snapshot: MineSnapshot | TodoSnapshot, options: ListOptions): string[] {
  const rows =
    snapshot.command === "mine"
      ? snapshot.prs.map((pr) => mineRow(pr, options))
      : snapshot.prs.map((pr) => todoRow(pr, snapshot.viewer, options));
  const title = snapshot.command === "mine" ? "📤 Mine" : "📥 Todo";
  const asOf = time(new Date(snapshot.generatedAt), options.timeZone);
  const age = options.now.getTime() - Date.parse(snapshot.generatedAt);
  const when = age < 90_000 ? `${asOf}` : `as of ${asOf} (${ago(snapshot.generatedAt, options.now)} ago)`;
  const note = options.note ? `\n\n${options.note}` : "";

  if (rows.length === 0) {
    return [
      `${bold(title)} · ${when}\n\n📭 ${snapshot.command === "mine" ? "No open PRs of yours." : "Nothing waits for your review."}${note}`,
    ];
  }
  const pages = paginate(ordered(rows));
  return pages.map((page, i) => {
    const count = plural(rows.length, "PR");
    const paging = pages.length > 1 ? ` · ${i + 1}/${pages.length}` : "";
    return `${bold(title)} · ${count} · ${when}${paging}\n\n${page.join("\n\n")}${note}`;
  });
}
