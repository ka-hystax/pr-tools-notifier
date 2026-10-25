import { z } from "zod";

// `gh pr-tools [-p NAME] mine|todo --json`: exit 0 + one Snapshot on stdout; non-zero = failed tick.
export const SCHEMA_VERSION = 1;

const login = z.string().min(1); // deleted accounts are "ghost"
const iso = z.iso.datetime();

export const ThreadStateSchema = z.enum(["pending", "answered", "resolved"]);
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const ThreadSchema = z.object({
  id: z.string().min(1),
  state: ThreadStateSchema, // pending: open, waiting on PR owner; answered: owner replied last (2+ comments)
  opener: login,
  lastAuthor: login,
  watched: z.boolean(), // opener is in the profile's THREAD_WATCH_USERS
  commentCount: z.number().int().positive(),
  path: z.string().nullable(),
  url: z.url(), // last comment
  lastCommentAt: iso,
  excerpt: z.string(), // last comment, plain text, truncated by gh-pr-tools
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ReviewStateSchema = z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ReviewSchema = z.object({
  id: z.string().min(1),
  author: login,
  state: ReviewStateSchema,
  submittedAt: iso.nullable(),
  commitOid: z.string().nullable(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const ApprovalSchema = z.object({
  threshold: z.number().int().positive(),
  approvers: z.array(login),
  staleApprovers: z.array(login),
  changesRequestedBy: z.array(login),
  decision: z.enum(["approved", "approved_stale", "awaiting"]), // profile APPROVAL_THRESHOLD, not GitHub's reviewDecision
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const CiSchema = z.object({
  state: z.enum(["pass", "fail", "pending", "none"]), // fail as soon as one check has failed
  failedJobs: z.array(z.string()), // names of the failed checks, in rollup order
});
export type Ci = z.infer<typeof CiSchema>;

const pullRequestShape = {
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  branch: z.string(),
  author: login,
  isDraft: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
  headOid: z.string(),
  reviews: z.array(ReviewSchema),
  approval: ApprovalSchema,
  // mine: every thread; todo: only threads opened by viewer. null = lookup failed, keep previous state.
  threads: z.array(ThreadSchema).nullable(),
  threadsTruncated: z.boolean(),
};

export const MergeStateSchema = z.enum(["clean", "dirty", "behind", "blocked", "unstable", "draft", "has_hooks", "unknown"]); // GitHub mergeStateStatus, lowercased; dirty = conflicts
export type MergeState = z.infer<typeof MergeStateSchema>;

// The ticket named by the branch, or else the title. status: null = no Jira token, a failed lookup or an invisible ticket; url: null = no site.
export const JiraTicketSchema = z.object({
  key: z.string().min(1),
  url: z.string().nullable(),
  status: z.string().nullable(),
});
export type JiraTicket = z.infer<typeof JiraTicketSchema>;

export const MinePullRequestSchema = z.object({
  ...pullRequestShape,
  ci: CiSchema,
  mergeState: MergeStateSchema,
  pendingReviewers: z.array(z.string()), // users (login) and teams (name) whose review is still requested
  jira: JiraTicketSchema.nullable().optional(), // null = no ticket in the branch or title; absent = a gh-pr-tools without Jira
});
export type MinePullRequest = z.infer<typeof MinePullRequestSchema>;

export const TodoPullRequestSchema = z.object({
  ...pullRequestShape,
  requestedFromMe: z.boolean(), // directly or via a team the viewer belongs to
});
export type TodoPullRequest = z.infer<typeof TodoPullRequestSchema>;

const header = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: iso,
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  viewer: login,
};

export const MineSnapshotSchema = z.object({ ...header, command: z.literal("mine"), prs: z.array(MinePullRequestSchema) });
export type MineSnapshot = z.infer<typeof MineSnapshotSchema>;

export const TodoSnapshotSchema = z.object({ ...header, command: z.literal("todo"), prs: z.array(TodoPullRequestSchema) });
export type TodoSnapshot = z.infer<typeof TodoSnapshotSchema>;

export const SnapshotSchema = z.discriminatedUnion("command", [MineSnapshotSchema, TodoSnapshotSchema]);
export type Snapshot = z.infer<typeof SnapshotSchema>;

export class ContractError extends Error {}

export function parseSnapshot(raw: unknown): Snapshot {
  const version = typeof raw === "object" && raw !== null && "schemaVersion" in raw ? raw.schemaVersion : undefined;
  if (version !== SCHEMA_VERSION) {
    throw new ContractError(
      `unsupported schemaVersion ${String(version)} (expected ${SCHEMA_VERSION}); update gh-pr-tools or pr-tools-notifier`
    );
  }
  const result = SnapshotSchema.safeParse(raw);
  if (!result.success) {
    throw new ContractError(`invalid snapshot: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
