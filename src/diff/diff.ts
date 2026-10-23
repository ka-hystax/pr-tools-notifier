import type {
  Approval,
  JiraTicket,
  MinePullRequest,
  Review,
  Snapshot,
  Thread,
  ThreadState,
  TodoPullRequest,
} from "../contract/snapshot.js";

export interface Baseline {
  snapshot: Snapshot;
  missingTicks: Record<number, number>;
}

// Jira statuses that mean "go ahead and merge". While a PR's ticket is in any other one, a PR that is otherwise
// ready waits. Compared case-insensitively.
export interface MergeGate {
  statuses: string[];
}

// Where an approved PR stands on its way to the merge button, as of a snapshot.
export type MergeStatus =
  | { kind: "unapproved" }
  | { kind: "todo"; pendingThreads: number; firstPendingThreadUrl: string | null; ciFailed: boolean; needsRebase: boolean }
  | { kind: "waiting_ci" }
  | { kind: "checking" }
  | { kind: "github_blocked"; waitingFor: string[] }
  | { kind: "waiting_jira"; ticket: JiraTicket; wanted: string[] }
  | { kind: "ready" };

export type WaitingJira = Extract<MergeStatus, { kind: "waiting_jira" }>;

export interface PrRef {
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
}

export type NotifyEvent =
  | { kind: "thread_pending"; pr: PrRef; thread: Thread }
  | { kind: "review_approved"; pr: PrRef; review: Review; approval: Approval; status: MergeStatus }
  | { kind: "review_changes_requested"; pr: PrRef; review: Review; approval: Approval }
  | { kind: "review_requested"; pr: PrRef }
  | { kind: "thread_answered"; pr: PrRef; thread: Thread }
  | { kind: "ci_failed"; pr: PrRef; failedJobs: string[] }
  | { kind: "ready_to_merge"; pr: PrRef; approval: Approval; ticket?: JiraTicket } // ticket: already in the merge status
  | { kind: "merge_blocked"; pr: PrRef; waitingFor: string[] }
  | { kind: "review_passed"; pr: PrRef; approval: Approval; status: WaitingJira }
  | { kind: "ticket_in_merge"; pr: PrRef; approval: Approval; ticket: JiraTicket; status: MergeStatus };

export const MAX_MISSING_TICKS = 3;

type PullRequest = MinePullRequest | TodoPullRequest;
type Ctx = { repo: string; viewer: string };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function eventId(e: NotifyEvent): string {
  return "thread" in e ? e.thread.id : "review" in e ? e.review.id : "";
}

function compareEvents(a: NotifyEvent, b: NotifyEvent): number {
  return a.pr.number - b.pr.number || compareText(a.kind, b.kind) || compareText(eventId(a), eventId(b));
}

function prRef(ctx: Ctx, pr: PullRequest): PrRef {
  return { repo: ctx.repo, number: pr.number, url: pr.url, title: pr.title, author: pr.author };
}

function enteringState(prev: Thread[] | null | undefined, curr: Thread[] | null, state: ThreadState): Thread[] {
  if (!prev || !curr) return [];
  const prevState = new Map(prev.map((t) => [t.id, t.state]));
  return curr.filter((t) => t.state === state && prevState.get(t.id) !== state);
}

function carryThreads<P extends PullRequest>(before: P | undefined, now: P): P {
  return now.threads === null && before?.threads ? { ...now, threads: before.threads } : now;
}

// Only a pending thread (still waiting for the author) holds a merge back; answered and resolved ones do not.
// Approvals made before a rebase or a small fix (stale) still count; if GitHub insists on fresh ones, it reports "blocked".
export function mergeStatus(
  pr: MinePullRequest,
  threads: Thread[] | null = pr.threads,
  hold: WaitingJira | null = null
): MergeStatus {
  if (pr.approval.decision === "awaiting") return { kind: "unapproved" };
  const pending = (threads ?? []).filter((t) => t.state === "pending");
  const first = [...pending].sort((a, b) => compareText(a.lastCommentAt, b.lastCommentAt) || compareText(a.id, b.id))[0];
  const ciFailed = pr.ci.state === "fail";
  const needsRebase = pr.mergeState === "dirty" || pr.mergeState === "behind";
  if (pending.length > 0 || ciFailed || needsRebase) {
    return { kind: "todo", pendingThreads: pending.length, firstPendingThreadUrl: first?.url ?? null, ciFailed, needsRebase };
  }
  if (pr.ci.state === "pending") return { kind: "waiting_ci" };
  if (pr.mergeState === "unknown") return { kind: "checking" };
  if (pr.mergeState === "blocked") return { kind: "github_blocked", waitingFor: pr.pendingReviewers };
  return hold ?? { kind: "ready" };
}

// The ticket holds the merge back when a gate is set and the ticket is not (yet) in one of its statuses;
// an unknown status (no token, failed lookup) counts as "not yet". PRs without a ticket are never held.
export function holdFor(
  pr: MinePullRequest,
  gate: MergeGate | undefined,
  ticket: JiraTicket | null | undefined = pr.jira
): WaitingJira | null {
  if (!gate || !ticket) return null;
  const status = ticket.status?.trim().toLowerCase();
  if (status !== undefined && gate.statuses.some((s) => s.trim().toLowerCase() === status)) return null;
  return { kind: "waiting_jira", ticket, wanted: gate.statuses };
}

// A failed lookup leaves the status null: keep the last real one for the same ticket, as with GitHub's "unknown".
function carryTicket(old: MinePullRequest[], curr: MinePullRequest[]): MinePullRequest[] {
  const before = new Map(old.map((p) => [p.number, p.jira]));
  return curr.map((now) => {
    const prev = before.get(now.number);
    const keep = now.jira && now.jira.status === null && prev && prev.key === now.jira.key && prev.status !== null;
    return keep ? { ...now, jira: { ...now.jira!, status: prev.status } } : now;
  });
}

// GitHub answers "unknown" while it recomputes mergeability. For the same commit the last real answer is kept
// instead of guessing, so a conflict is not mistaken for a clean branch and a clean one is not announced twice.
function carryMergeState(old: MinePullRequest[], curr: MinePullRequest[]): MinePullRequest[] {
  const before = new Map(old.map((p) => [p.number, p]));
  return curr.map((now) => {
    const prev = before.get(now.number);
    const keep = now.mergeState === "unknown" && prev && prev.mergeState !== "unknown" && prev.headOid === now.headOid;
    return keep ? { ...now, mergeState: prev.mergeState } : now;
  });
}

function mineEvents(ctx: Ctx, before: MinePullRequest | undefined, now: MinePullRequest, gate?: MergeGate): NotifyEvent[] {
  const pr = prRef(ctx, now);
  const events: NotifyEvent[] = [];
  for (const thread of enteringState(before?.threads, now.threads, "pending")) {
    if (thread.lastAuthor !== ctx.viewer) events.push({ kind: "thread_pending", pr, thread });
  }
  if (!before) return events;

  const failedBefore = before.ci.state === "fail" && before.headOid === now.headOid;
  if (now.ci.state === "fail" && !failedBefore) events.push({ kind: "ci_failed", pr, failedJobs: now.ci.failedJobs });

  const hold = holdFor(now, gate);
  // Without an earlier reading of the same ticket (Jira just switched on, key changed) nothing "moved".
  const sameTicket = before.jira && now.jira && before.jira.key === now.jira.key ? before.jira : null;
  const heldBefore = sameTicket ? holdFor(before, gate, sameTicket) : hold;
  const status = mergeStatus(now, now.threads ?? before.threads, hold);
  const known = new Set(before.reviews.map((r) => r.id));
  for (const review of now.reviews) {
    if (known.has(review.id) || review.author === ctx.viewer) continue;
    if (review.state === "APPROVED") events.push({ kind: "review_approved", pr, review, approval: now.approval, status });
    if (review.state === "CHANGES_REQUESTED") {
      events.push({ kind: "review_changes_requested", pr, review, approval: now.approval });
    }
  }

  // An approval already carries the verdict, so these only report changes that come without one.
  if (!events.some((e) => e.kind === "review_approved")) {
    const was = mergeStatus(before, before.threads, heldBefore).kind;
    if (heldBefore && !hold && now.jira) {
      events.push({ kind: "ticket_in_merge", pr, approval: now.approval, ticket: now.jira, status });
    } else {
      if (status.kind === "ready" && was !== "ready") {
        const inMerge = gate && now.jira ? { ticket: now.jira } : {};
        events.push({ kind: "ready_to_merge", pr, approval: now.approval, ...inMerge });
      }
      if (status.kind === "waiting_jira" && was !== "waiting_jira") {
        events.push({ kind: "review_passed", pr, approval: now.approval, status });
      }
      if (status.kind === "github_blocked" && was !== "github_blocked") {
        events.push({ kind: "merge_blocked", pr, waitingFor: status.waitingFor });
      }
    }
  }
  return events;
}

function todoEvents(ctx: Ctx, before: TodoPullRequest | undefined, now: TodoPullRequest): NotifyEvent[] {
  if (now.isDraft) return [];
  const pr = prRef(ctx, now);
  const events: NotifyEvent[] = [];
  // A request seen while the PR was a draft was never announced.
  const alreadyAnnounced = before !== undefined && before.requestedFromMe && !before.isDraft;
  if (now.requestedFromMe && !alreadyAnnounced) events.push({ kind: "review_requested", pr });
  for (const thread of enteringState(before?.threads, now.threads, "answered")) {
    if (thread.opener === ctx.viewer && thread.lastAuthor !== ctx.viewer) {
      events.push({ kind: "thread_answered", pr, thread });
    }
  }
  return events;
}

// Nothing when the PR is new or either lookup failed: that tick only seeds.

function diffPrs<P extends PullRequest>(
  prevPrs: P[],
  currPrs: P[],
  prevMissing: Record<number, number>,
  eventsFor: (before: P | undefined, now: P) => NotifyEvent[]
) {
  const before = new Map(prevPrs.map((p) => [p.number, p]));
  const present = new Set(currPrs.map((p) => p.number));
  const events = currPrs.flatMap((now) => eventsFor(before.get(now.number), now));
  const prs = currPrs.map((now) => carryThreads(before.get(now.number), now));
  const missingTicks: Record<number, number> = {};
  for (const old of prevPrs) {
    if (present.has(old.number)) continue;
    const ticks = (prevMissing[old.number] ?? 0) + 1;
    if (ticks > MAX_MISSING_TICKS) continue;
    prs.push(old);
    missingTicks[old.number] = ticks;
  }
  return { events, prs, missingTicks };
}

export function computeEvents(
  prev: Baseline | null,
  curr: Snapshot,
  gate?: MergeGate
): { events: NotifyEvent[]; next: Baseline } {
  const ctx = { repo: curr.repo, viewer: curr.viewer };
  if (prev !== null && prev.snapshot.repo === curr.repo) {
    const old = prev.snapshot;
    if (old.command === "mine" && curr.command === "mine") {
      const { events, prs, missingTicks } = diffPrs(
        old.prs,
        carryTicket(old.prs, carryMergeState(old.prs, curr.prs)),
        prev.missingTicks,
        (before, now) => mineEvents(ctx, before, now, gate)
      );
      return { events: events.sort(compareEvents), next: { snapshot: { ...curr, prs }, missingTicks } };
    }
    if (old.command === "todo" && curr.command === "todo") {
      const { events, prs, missingTicks } = diffPrs(old.prs, curr.prs, prev.missingTicks, (before, now) =>
        todoEvents(ctx, before, now)
      );
      return { events: events.sort(compareEvents), next: { snapshot: { ...curr, prs }, missingTicks } };
    }
  }
  return { events: [], next: { snapshot: curr, missingTicks: {} } };
}
