import type { MineSnapshot, Review, Thread, TodoSnapshot } from "../contract/snapshot.js";
import { holdFor, type MergeGate } from "../diff/diff.js";
import { approvalCount, bold, clip, escapeHtml, italic, link, names } from "../format/format.js";

const TITLE_MAX = 60;
const PAGE_BUDGET = 3_800;
const HEADER_RESERVE = 160;

export interface ListOptions {
  now: Date;
  timeZone?: string;
  gate?: MergeGate;
  // Shown under the list, for example that a refresh failed and the data is older.
  note?: string;
}

// A list is two blocks under bold headers; the icons in a row are the ones notifications use.
interface Block {
  title?: string; // absent: no header, only the empty text
  rows: Row[];
  // Shown under the header when there are no rows; without it an empty block is left out.
  empty?: string;
  // The profile it belongs to, when a run polls several.
  profile?: string;
}

// One profile's part of a list; the profile is named when a run polls several.
export interface ListPart {
  profile?: string;
  snapshot: MineSnapshot | TodoSnapshot;
}

interface Row {
  rank: number;
  createdAt: string;
  text: string;
}

type MinePr = MineSnapshot["prs"][number];
type TodoPr = TodoSnapshot["prs"][number];

// "5m", "3h", "4d": how long ago, in the biggest unit that is at least one.
export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function earliest(threads: Thread[]): Thread | undefined {
  return [...threads].sort((a, b) => (a.lastCommentAt < b.lastCommentAt ? -1 : a.lastCommentAt > b.lastCommentAt ? 1 : 0))[0];
}

function row(pr: { number: number; url: string; title: string; createdAt: string }, rank: number, items: string[]): Row {
  const title = `${link(pr.url, bold(`#${pr.number}`))} ${escapeHtml(clip(pr.title, TITLE_MAX))}`;
  return { rank, createdAt: pr.createdAt, text: `${title}\n${items.join(" · ")}` };
}

function ticketChip(pr: MinePr): string | null {
  if (!pr.jira?.status) return null;
  return `🎫 ${pr.jira.url ? link(pr.jira.url, escapeHtml(pr.jira.status)) : escapeHtml(pr.jira.status)}`;
}

// What the author can fix whatever the reviews say: a failed build and a branch that does not merge.
function fixes(pr: MinePr): string[] {
  const items: string[] = [];
  if (pr.ci.state === "fail") items.push(`❌ ${link(`${pr.url}/checks`, "CI failed")}`);
  if (pr.mergeState === "dirty") items.push("🔀 conflicts");
  if (pr.mergeState === "behind") items.push("🔀 needs a rebase");
  return items;
}

// Approved: enough approvals (stale ones count), no open threads, and GitHub not waiting for a required review.
// Ready ones first, then what to fix, then what to wait for.
function approvedRow(pr: MinePr, options: ListOptions): Row {
  const fix = fixes(pr);
  const wait: string[] = [];
  if (pr.ci.state === "pending") wait.push("⏳ CI running");
  if (pr.mergeState === "unknown") wait.push("⏳ GitHub is checking the branch");
  const hold = holdFor(pr, options.gate);
  if (hold) {
    const now = hold.ticket.status === null ? "Jira status unavailable" : hold.ticket.status;
    const ticket = hold.ticket.url ? link(hold.ticket.url, escapeHtml(now)) : escapeHtml(now);
    wait.push(`🎫 waiting for the merge status (${ticket})`);
  }
  const info = [approvalCount(pr.approval)];
  const chip = hold ? null : ticketChip(pr);
  if (chip) info.push(chip);
  info.push(ago(pr.createdAt, options.now));

  if (fix.length > 0) return row(pr, 1, [...fix, ...wait, ...info]);
  // Waiting on GitHub or CI usually ends sooner than waiting on QA to move the ticket.
  if (wait.length > 0) return row(pr, hold && wait.length === 1 ? 3 : 2, [...wait, ...info]);
  return row(pr, 0, ["🟢 ready to merge", ...info]);
}

// In review: what you can answer first (requested changes, open threads, a broken build), then what waits for reviewers.
function inReviewRow(pr: MinePr, options: ListOptions): Row {
  const pending = (pr.threads ?? []).filter((t) => t.state === "pending");
  const changes = pr.approval.changesRequestedBy;
  const yours: string[] = [];
  if (changes.length > 0) yours.push(`🔄 changes requested by ${names(changes)}`);
  if (pending.length > 0)
    yours.push(`💬 ${link(earliest(pending)?.url ?? pr.url, `${plural(pending.length, "open thread")}`)}`);
  yours.push(...fixes(pr));

  const wait: string[] = [];
  if (pr.isDraft) {
    wait.push("📝 draft");
  } else if (pr.approval.decision === "awaiting") {
    wait.push(pr.pendingReviewers.length > 0 ? `⏳ review from ${names(pr.pendingReviewers)}` : "⏳ needs approvals");
  } else if (pr.mergeState === "blocked") {
    wait.push(pr.pendingReviewers.length > 0 ? `🚧 review from ${names(pr.pendingReviewers)}` : "🚧 GitHub blocks the merge");
  }
  const info = [approvalCount(pr.approval)];
  const chip = ticketChip(pr);
  if (chip) info.push(chip);
  info.push(ago(pr.createdAt, options.now));

  const rank = yours.length > 0 ? (changes.length > 0 ? 0 : 1) : pr.isDraft ? 3 : 2;
  return row(pr, rank, [...yours, ...wait, ...info]);
}

function isApproved(pr: MinePr): boolean {
  const openThreads = (pr.threads ?? []).some((t) => t.state === "pending");
  return (
    pr.approval.decision !== "awaiting" &&
    pr.approval.changesRequestedBy.length === 0 &&
    !openThreads &&
    !pr.isDraft &&
    pr.mergeState !== "blocked"
  );
}

function mineBlocks(snapshot: MineSnapshot, options: ListOptions): Block[] {
  return [
    {
      title: "✅ Approved",
      rows: snapshot.prs.filter(isApproved).map((pr) => approvedRow(pr, options)),
      empty: "No PR has enough approvals yet.",
    },
    { title: "👀 In review", rows: snapshot.prs.filter((pr) => !isApproved(pr)).map((pr) => inReviewRow(pr, options)) },
  ];
}

// The viewer's latest submitted verdict on a PR, and whether commits landed after it.
function myVerdict(pr: TodoPr, viewer: string): string | null {
  const mine = pr.reviews
    .filter((r): r is Review & { submittedAt: string } => r.author === viewer && r.submittedAt !== null)
    .filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED")
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
  // A comment after an approval does not take the approval back.
  const last = mine.filter((r) => r.state !== "COMMENTED").at(-1) ?? mine.at(-1);
  if (!last) return null;
  const verdict =
    last.state === "APPROVED"
      ? "✅ you approved"
      : last.state === "CHANGES_REQUESTED"
        ? "🔄 you requested changes"
        : "💬 you commented";
  const newer = last.commitOid !== null && last.commitOid !== pr.headOid ? ", new commits since" : "";
  return `${verdict}${newer}`;
}

function todoBlocks(snapshot: TodoSnapshot, options: ListOptions): Block[] {
  const turn: Row[] = [];
  const waiting: Row[] = [];
  for (const pr of snapshot.prs) {
    const threads = pr.threads ?? [];
    const replies = threads.filter((t) => t.state === "answered" && t.lastAuthor !== snapshot.viewer);
    const open = threads.filter((t) => t.state === "pending");
    const info = [`by ${escapeHtml(pr.author)}`, approvalCount(pr.approval), ago(pr.createdAt, options.now)];

    const yours: string[] = [];
    if (pr.requestedFromMe) yours.push("🔔 review requested");
    if (replies.length > 0) {
      yours.push(
        `↩️ ${link(earliest(replies)?.url ?? pr.url, `${plural(replies.length, "reply", "replies")} in your threads`)}`
      );
    }
    if (yours.length > 0) {
      turn.push(row(pr, pr.requestedFromMe ? 0 : 1, [...yours, ...info]));
      continue;
    }
    const items: string[] = [];
    if (open.length > 0) {
      items.push(`💬 ${link(earliest(open)?.url ?? pr.url, `${open.length} of your threads open`)}`);
    }
    // Open threads of yours already say you commented; an approval or a change request is still worth showing.
    const verdict = myVerdict(pr, snapshot.viewer);
    if (verdict && !(open.length > 0 && verdict.startsWith("💬"))) items.push(verdict);
    if (items.length === 0) items.push("👀 you are a reviewer");
    waiting.push(row(pr, 0, [...items, ...info]));
  }
  return [
    { title: "🔔 Your turn", rows: turn, empty: "Nothing needs you right now." },
    { title: "⏳ Waiting for authors", rows: waiting },
  ];
}

// The header of a profile's section, in a run that polls several.
export function profileHeading(profile: string): string {
  return `🗂 ${bold(profile)}`;
}

export function time(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

interface Line {
  block: number;
  first: boolean;
  text: string;
}

function lines(blocks: Block[]): Line[] {
  return blocks.flatMap((block, b) =>
    block.rows.length === 0
      ? [{ block: b, first: true, text: italic(block.empty ?? "") }]
      : [...block.rows]
          .sort((x, y) => x.rank - y.rank || (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0))
          .map((r, i) => ({ block: b, first: i === 0, text: r.text }))
  );
}

// Greedy pages that each fit in one message, whatever the number of PRs.
export function paginate<L extends { text: string }>(all: L[]): L[][] {
  const pages: L[][] = [[]];
  let size = 0;
  for (const line of all) {
    const cost = line.text.length + 2;
    if (size + cost > PAGE_BUDGET - HEADER_RESERVE && pages.at(-1)!.length > 0) {
      pages.push([]);
      size = 0;
    }
    pages.at(-1)!.push(line);
    size += cost;
  }
  return pages;
}

// A block starts under its bold header, two empty lines below the previous block; a block that goes on from the
// previous page says so. A profile's blocks follow its heading.
function renderPage(page: Line[], blocks: Block[]): string {
  const parts: string[] = [];
  let profile: string | undefined;
  page.forEach((line, i) => {
    const block = blocks[line.block]!;
    const heading = block.profile !== undefined && (i === 0 || block.profile !== profile);
    if (heading) {
      parts.push(`${parts.length > 0 ? "\n" : ""}${profileHeading(block.profile!)}`);
      profile = block.profile;
    }
    if ((line.first || i === 0) && block.title !== undefined) {
      const header = bold(`${block.title} · ${block.rows.length}`);
      const gap = parts.length > 0 && !heading ? "\n" : "";
      parts.push(`${gap}${line.first ? header : `${header} ${italic("(continued)")}`}`);
    }
    parts.push(line.text);
  });
  return parts.join("\n\n");
}

function blocksOf(snapshot: MineSnapshot | TodoSnapshot, options: ListOptions): Block[] {
  return (snapshot.command === "mine" ? mineBlocks(snapshot, options) : todoBlocks(snapshot, options)).filter(
    (b) => b.rows.length > 0 || b.empty !== undefined
  );
}

// One message text per page of `mine` or `todo`, from a snapshot (the saved one or a fresh one).
export function renderList(snapshot: MineSnapshot | TodoSnapshot, options: ListOptions): string[] {
  return renderLists([{ snapshot }], options);
}

// The same for several profiles, one section each; the oldest snapshot dates the list.
export function renderLists(parts: ListPart[], options: ListOptions): string[] {
  const command = parts[0]!.snapshot.command;
  const nothing = command === "mine" ? "No open PRs of yours." : "Nothing waits for your review.";
  const blocks = parts.flatMap((part): Block[] =>
    part.snapshot.prs.length === 0
      ? [{ rows: [], empty: nothing, ...(part.profile !== undefined ? { profile: part.profile } : {}) }]
      : blocksOf(part.snapshot, options).map((b) => (part.profile !== undefined ? { ...b, profile: part.profile } : b))
  );
  const total = parts.reduce((sum, part) => sum + part.snapshot.prs.length, 0);
  const generatedAt = parts.map((p) => p.snapshot.generatedAt).sort()[0]!;
  const title = command === "mine" ? "📤 Mine" : "📥 Todo";
  const asOf = time(new Date(generatedAt), options.timeZone);
  const age = options.now.getTime() - Date.parse(generatedAt);
  const when = age < 90_000 ? `${asOf}` : `as of ${asOf} (${ago(generatedAt, options.now)} ago)`;
  const note = options.note ? `\n\n${options.note}` : "";

  if (total === 0) return [`${bold(title)} · ${when}\n\n📭 ${nothing}${note}`];
  const pages = paginate(lines(blocks));
  return pages.map((page, i) => {
    const count = plural(total, "PR");
    const paging = pages.length > 1 ? ` · ${i + 1}/${pages.length}` : "";
    return `${bold(title)} · ${count} · ${when}${paging}\n\n${renderPage(page, blocks)}${note}`;
  });
}
