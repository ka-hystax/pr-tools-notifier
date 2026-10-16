import type { Approval, Thread } from "../contract/snapshot.js";
import type { MergeStatus, NotifyEvent, PrRef } from "../diff/diff.js";

const repo = "acme/web";

function pr(number: number, title: string, author = "me"): PrRef {
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, title, author };
}

function thread(n: number, over: Partial<Thread> = {}): Thread {
  return {
    id: `T${n}`,
    state: "pending",
    opener: "alice",
    lastAuthor: "alice",
    watched: false,
    commentCount: 1,
    path: null,
    url: `https://github.com/${repo}/pull/101#discussion_r${n}`,
    lastCommentAt: `2026-10-13T09:${String(n).padStart(2, "0")}:00Z`,
    excerpt: "Should this be disabled while the request is in flight?",
    ...over,
  };
}

const approval = (over: Partial<Approval> = {}): Approval => ({
  threshold: 2,
  approvers: ["alice"],
  staleApprovers: [],
  changesRequestedBy: [],
  decision: "awaiting",
  ...over,
});

const review = (id: string, author: string, state: "APPROVED" | "CHANGES_REQUESTED") => ({
  id,
  author,
  state,
  submittedAt: "2026-10-13T10:00:00Z",
  commitOid: "abc",
});

const threadsUrl = `https://github.com/${repo}/pull/101#discussion_r1`;
const todo = (over: Partial<Extract<MergeStatus, { kind: "todo" }>>): MergeStatus => ({
  kind: "todo",
  pendingThreads: 0,
  firstPendingThreadUrl: null,
  ciFailed: false,
  needsRebase: false,
  ...over,
});

const P101 = pr(101, "PRJ-1001. Add export button");
const P102 = pr(102, "PRJ-1002. Fix locale fallback");
const P201 = pr(201, "PRJ-2001. Add audit log", "alice");

// One entry per message, covering every kind of notification and both loud and silent delivery.
export const SAMPLE_MESSAGES: { label: string; events: NotifyEvent[] }[] = [
  { label: "new thread", events: [{ kind: "thread_pending", pr: P101, thread: thread(1) }] },
  {
    label: "reply in a long thread",
    events: [
      {
        kind: "thread_pending",
        pr: P101,
        thread: thread(2, { commentCount: 4, lastAuthor: "bob", excerpt: "Agreed, but the export path has the same problem." }),
      },
    ],
  },
  {
    label: "bot threads (silent)",
    events: Array.from({ length: 5 }, (_, k) => ({
      kind: "thread_pending" as const,
      pr: P101,
      thread: thread(10 + k, { watched: true, opener: "coderabbitai", lastAuthor: "coderabbitai" }),
    })),
  },
  {
    label: "reply to your thread",
    events: [
      {
        kind: "thread_answered",
        pr: P201,
        thread: thread(3, { lastAuthor: "bob", commentCount: 2, excerpt: "Good catch, updated the predicate." }),
      },
    ],
  },
  {
    label: "approval below the threshold (silent)",
    events: [
      {
        kind: "review_approved",
        pr: P101,
        review: review("R1", "alice", "APPROVED"),
        approval: approval(),
        status: { kind: "unapproved" },
      },
    ],
  },
  ...(
    [
      ["approval that makes it mergeable", { kind: "ready" }],
      ["approved, threads still pending", todo({ pendingThreads: 2, firstPendingThreadUrl: threadsUrl })],
      ["approved, needs a rebase", todo({ needsRebase: true })],
      [
        "approved, threads, failing CI and a rebase",
        todo({ pendingThreads: 2, firstPendingThreadUrl: threadsUrl, ciFailed: true, needsRebase: true }),
      ],
      ["approved, CI still running", { kind: "waiting_ci" }],
      ["approved, GitHub still checking the branch", { kind: "checking" }],
      ["approved, but GitHub blocks the merge", { kind: "github_blocked", waitingFor: ["backend"] }],
    ] as [string, MergeStatus][]
  ).map(([label, status]) => ({
    label,
    events: [
      {
        kind: "review_approved" as const,
        pr: P101,
        review: review("R2", "carol", "APPROVED"),
        approval: approval({ approvers: ["alice", "carol"], decision: "approved" }),
        status,
      },
    ],
  })),
  {
    label: "blockers cleared, ready to merge",
    events: [{ kind: "ready_to_merge", pr: P102, approval: approval({ approvers: ["alice", "carol"], decision: "approved" }) }],
  },
  {
    label: "ready to merge, approvals predate the latest commits",
    events: [
      {
        kind: "ready_to_merge",
        pr: P102,
        approval: approval({ approvers: [], staleApprovers: ["alice", "carol"], decision: "approved_stale" }),
      },
    ],
  },
  { label: "all set, but GitHub blocks the merge", events: [{ kind: "merge_blocked", pr: P102, waitingFor: ["backend"] }] },
  {
    label: "changes requested",
    events: [
      { kind: "review_changes_requested", pr: P102, review: review("R3", "bob", "CHANGES_REQUESTED"), approval: approval() },
    ],
  },
  { label: "review requested", events: [{ kind: "review_requested", pr: P201 }] },
  { label: "CI failed", events: [{ kind: "ci_failed", pr: P102, failedJobs: ["Build UI / build_image", "e2e (chromium)"] }] },
];
