import { describe, expect, test } from "vitest";
import {
  parseSnapshot,
  type MineSnapshot,
  type Review,
  type Snapshot,
  type Thread,
  type TodoSnapshot,
} from "../../contract/snapshot.js";
import { computeEvents, type Baseline, type NotifyEvent } from "../diff.js";
import { readFixture, type FixtureName } from "../../__tests__/fixtures.js";

function load(name: FixtureName): Snapshot {
  return parseSnapshot(readFixture(name));
}

function mine(edit?: (s: MineSnapshot) => void): MineSnapshot {
  const s = load("mine");
  if (s.command !== "mine") throw new Error("fixture is not mine");
  edit?.(s);
  return s;
}

function todo(edit?: (s: TodoSnapshot) => void): TodoSnapshot {
  const s = load("todo");
  if (s.command !== "todo") throw new Error("fixture is not todo");
  edit?.(s);
  return s;
}

function find<T extends { number?: number; id?: string }>(items: T[], key: number | string): T {
  const item = items.find((i) => i.number === key || i.id === key);
  if (!item) throw new Error(`no item ${key}`);
  return item;
}

const mkThread = (o: Partial<Thread> & Pick<Thread, "id">): Thread => ({
  state: "pending",
  opener: "alice",
  lastAuthor: "alice",
  watched: false,
  commentCount: 1,
  path: "src/a.ts",
  url: `https://github.com/acme/web/pull/1#${o.id}`,
  lastCommentAt: "2026-10-13T09:00:00Z",
  excerpt: "text",
  ...o,
});

const mkReview = (o: Partial<Review> & Pick<Review, "id">): Review => ({
  author: "carol",
  state: "APPROVED",
  submittedAt: "2026-10-13T11:00:00Z",
  commitOid: null,
  ...o,
});

const base = (snapshot: Snapshot, missingTicks: Record<number, number> = {}): Baseline => ({ snapshot, missingTicks });

function summary(events: NotifyEvent[]): string[] {
  return events.map((e) => {
    const id = "thread" in e ? e.thread.id : "review" in e ? e.review.id : "";
    return `${e.pr.number} ${e.kind}${id ? ` ${id}` : ""}`;
  });
}

function replay(prev: Baseline | null, snapshots: Snapshot[]) {
  const events: NotifyEvent[][] = [];
  let next = prev;
  for (const snapshot of snapshots) {
    const r = computeEvents(next, snapshot);
    events.push(r.events);
    next = r.next;
  }
  if (!next) throw new Error("no snapshots");
  return { events, next };
}

const pr101 = (s: MineSnapshot) => find(s.prs, 101);
const pr102 = (s: MineSnapshot) => find(s.prs, 102);

function threadsOf(s: MineSnapshot, number: number): Thread[] {
  const threads = find(s.prs, number).threads;
  if (!threads) throw new Error("threads null");
  return threads;
}

describe("seeding", () => {
  test("emits nothing on the first run and stores the snapshot as is", () => {
    const curr = mine();
    const { events, next } = computeEvents(null, curr);
    expect(events).toEqual([]);
    expect(next).toEqual({ snapshot: curr, missingTicks: {} });
  });

  test("seeds silently when the repo changes", () => {
    const prev = mine((s) => {
      s.repo = "acme/api";
      pr101(s).threads = [];
    });
    const curr = mine();
    const { events, next } = computeEvents(base(prev), curr);
    expect(events).toEqual([]);
    expect(next).toEqual({ snapshot: curr, missingTicks: {} });
  });

  test("seeds silently when the command changes", () => {
    const curr = todo();
    const { events, next } = computeEvents(base(mine()), curr);
    expect(events).toEqual([]);
    expect(next).toEqual({ snapshot: curr, missingTicks: {} });
  });

  test("is idempotent and keeps the baseline equal to the snapshot", () => {
    for (const snapshot of [mine(), todo()]) {
      const { events, next } = computeEvents(base(snapshot), snapshot);
      expect(events).toEqual([]);
      expect(next).toEqual({ snapshot, missingTicks: {} });
    }
  });

  test("stays silent on the same input after an eventful tick", () => {
    const prev = mine((s) => {
      pr101(s).threads = [];
    });
    const first = computeEvents(base(prev), mine());
    expect(first.events).not.toEqual([]);
    expect(computeEvents(first.next, mine()).events).toEqual([]);
  });

  test("does not mutate its inputs and returns a JSON-serializable baseline", () => {
    const prev = base(mine((s) => (pr101(s).threads = [])));
    const curr = mine();
    const prevCopy = structuredClone(prev);
    const currCopy = structuredClone(curr);
    const { next } = computeEvents(prev, curr);
    expect(prev).toEqual(prevCopy);
    expect(curr).toEqual(currCopy);
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });
});

describe("mine: thread_pending", () => {
  test("announces a new pending thread with PR and thread data", () => {
    const prev = mine((s) => {
      pr101(s).threads = threadsOf(s, 101).filter((t) => t.id !== "PRRT_kwDOAAAA01");
    });
    const curr = mine();
    const { events } = computeEvents(base(prev), curr);
    expect(events).toEqual([
      {
        kind: "thread_pending",
        pr: {
          repo: "acme/web",
          number: 101,
          url: "https://github.com/acme/web/pull/101",
          title: "PRJ-1001: add export button",
          author: "dev-me",
        },
        thread: find(threadsOf(curr, 101), "PRRT_kwDOAAAA01"),
      },
    ]);
  });

  test("compares per thread, not counts: one resolved + one newly pending in the same tick", () => {
    const a = mkThread({ id: "A" });
    const b = mkThread({ id: "B" });
    const c = mkThread({ id: "C" });
    const prev = mine((s) => (pr101(s).threads = [a, b]));
    const curr = mine((s) => (pr101(s).threads = [{ ...a, state: "resolved" }, b, c]));
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["101 thread_pending C"]);
  });

  test("announces answered -> pending when the reviewer replies again", () => {
    const answered = mkThread({ id: "T", state: "answered", lastAuthor: "dev-me", commentCount: 2 });
    const prev = mine((s) => (pr101(s).threads = [answered]));
    const curr = mine((s) => (pr101(s).threads = [{ ...answered, state: "pending", lastAuthor: "alice", commentCount: 3 }]));
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["101 thread_pending T"]);
  });

  test("announces resolved -> pending when the thread is reopened", () => {
    const resolved = mkThread({ id: "T", state: "resolved", lastAuthor: "dev-me" });
    const prev = mine((s) => (pr101(s).threads = [resolved]));
    const curr = mine((s) => (pr101(s).threads = [{ ...resolved, state: "pending", lastAuthor: "alice" }]));
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["101 thread_pending T"]);
  });

  test("announces watched-login (bot) threads like any other; the formatter renders them compactly", () => {
    const prev = mine((s) => (pr101(s).threads = []));
    const curr = mine(
      (s) => (pr101(s).threads = [mkThread({ id: "BOT", watched: true, opener: "coderabbitai", lastAuthor: "coderabbitai" })])
    );
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["101 thread_pending BOT"]);
  });

  test("suppresses a thread whose last author is the viewer", () => {
    const prev = mine((s) => (pr101(s).threads = []));
    const curr = mine((s) => (pr101(s).threads = [mkThread({ id: "SELF", lastAuthor: "dev-me" })]));
    expect(computeEvents(base(prev), curr).events).toEqual([]);
  });

  test("does not re-announce a thread that stays pending", () => {
    const prev = mine((s) => (pr101(s).threads = [mkThread({ id: "T" })]));
    const curr = mine((s) => (pr101(s).threads = [mkThread({ id: "T", excerpt: "edited", commentCount: 2 })]));
    expect(computeEvents(base(prev), curr).events).toEqual([]);
  });
});

describe("mine: reviews", () => {
  const withReviews = (reviews: Review[], approval?: Partial<MineSnapshot["prs"][number]["approval"]>) =>
    mine((s) => {
      const pr = pr101(s);
      pr.reviews = reviews;
      if (approval) pr.approval = { ...pr.approval, ...approval };
    });

  test("announces a new approval with the current approval summary", () => {
    const prev = mine();
    const curr = withReviews([...pr101(mine()).reviews, mkReview({ id: "R3", author: "carol" })], {
      approvers: ["alice", "carol"],
      decision: "approved",
    });
    const { events } = computeEvents(base(prev), curr);
    expect(events).toEqual([
      {
        kind: "review_approved",
        pr: expect.objectContaining({ number: 101 }),
        review: mkReview({ id: "R3", author: "carol" }),
        approval: { ...pr101(curr).approval, approvers: ["alice", "carol"], decision: "approved" },
        status: expect.objectContaining({ kind: "todo", pendingThreads: 2, ciFailed: true, needsRebase: true }),
      },
    ]);
  });

  test("announces every new approval, also after the threshold is already met", () => {
    const met = [mkReview({ id: "R1", author: "alice" }), mkReview({ id: "R2", author: "carol" })];
    const prev = withReviews(met, { approvers: ["alice", "carol"], decision: "approved" });
    const curr = withReviews([...met, mkReview({ id: "R3", author: "dave" })], {
      approvers: ["alice", "carol", "dave"],
      decision: "approved",
    });
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["101 review_approved R3"]);
  });

  test("announces two approvals landing in one tick", () => {
    const prev = withReviews([]);
    const curr = withReviews([mkReview({ id: "R2", author: "dave" }), mkReview({ id: "R1", author: "carol" })]);
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["101 review_approved R1", "101 review_approved R2"]);
  });

  test("announces changes requested", () => {
    const prev = mine();
    const curr = withReviews([...pr101(mine()).reviews, mkReview({ id: "R3", author: "carol", state: "CHANGES_REQUESTED" })]);
    const { events } = computeEvents(base(prev), curr);
    expect(summary(events)).toEqual(["101 review_changes_requested R3"]);
  });

  test("stays silent for COMMENTED, DISMISSED and PENDING reviews", () => {
    const prev = mine();
    const curr = withReviews([
      ...pr101(mine()).reviews,
      mkReview({ id: "R3", state: "COMMENTED" }),
      mkReview({ id: "R4", state: "DISMISSED" }),
      mkReview({ id: "R5", state: "PENDING", submittedAt: null }),
    ]);
    expect(computeEvents(base(prev), curr).events).toEqual([]);
  });

  test("does not announce an existing review whose state changed to dismissed", () => {
    const prev = mine();
    const curr = withReviews(
      pr101(mine()).reviews.map((r) => (r.id === "PRR_kwDOAAAA01" ? { ...r, state: "DISMISSED" as const } : r))
    );
    expect(computeEvents(base(prev), curr).events).toEqual([]);
  });

  test("suppresses the viewer's own review", () => {
    const prev = mine();
    const curr = withReviews([...pr101(mine()).reviews, mkReview({ id: "R3", author: "dev-me" })]);
    expect(computeEvents(base(prev), curr).events).toEqual([]);
  });

  test("is not affected by a failed thread lookup", () => {
    const prev = mine();
    const curr = mine((s) => {
      pr102(s).reviews = [mkReview({ id: "R9", author: "carol" })];
    });
    expect(pr102(curr).threads).toBeNull();
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["102 review_approved R9"]);
  });

  test("does not special-case drafts", () => {
    const prev = mine();
    const curr = mine((s) => {
      find(s.prs, 103).reviews.push(mkReview({ id: "R9", author: "carol" }));
    });
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(["103 review_approved R9"]);
  });
});

describe("mine: PR new to the baseline", () => {
  test("seeds silently: no thread or review events", () => {
    const prev = mine((s) => {
      s.prs = s.prs.filter((p) => p.number !== 101);
    });
    const { events, next } = computeEvents(base(prev), mine());
    expect(events).toEqual([]);
    expect(find((next.snapshot as MineSnapshot).prs, 101).threads).toHaveLength(4);
    expect(computeEvents(next, mine()).events).toEqual([]);
  });
});

describe("threads lookup failures", () => {
  test("carries the previous threads forward when the lookup fails", () => {
    const good = mine();
    const failed = mine((s) => (pr101(s).threads = null));
    const { events, next } = computeEvents(base(good), failed);
    expect(events).toEqual([]);
    expect(pr101(next.snapshot as MineSnapshot).threads).toEqual(threadsOf(good, 101));
    expect(replay(next, [good]).events).toEqual([[]]);
  });

  test("still reports a change that happened during the outage once the lookup recovers", () => {
    const good = mine();
    const failed = mine((s) => (pr101(s).threads = null));
    const recovered = mine((s) => threadsOf(s, 101).push(mkThread({ id: "NEW" })));
    const { events } = replay(base(good), [failed, failed, recovered]);
    expect(events.map(summary)).toEqual([[], [], ["101 thread_pending NEW"]]);
  });

  test("keeps threads null when there was never a good lookup", () => {
    const { next } = computeEvents(base(mine()), mine());
    expect(pr102(next.snapshot as MineSnapshot).threads).toBeNull();
  });

  test("seeds silently on the first successful lookup (null -> list)", () => {
    const withThreads = mine((s) => (pr102(s).threads = [mkThread({ id: "T1" }), mkThread({ id: "T2", state: "answered" })]));
    const { events, next } = replay(base(mine()), [withThreads, withThreads]);
    expect(events).toEqual([[], []]);
    expect(pr102(next.snapshot as MineSnapshot).threads).toHaveLength(2);
  });

  test("announces changes after the null -> list seeding", () => {
    const seeded = mine((s) => (pr102(s).threads = [mkThread({ id: "T1", state: "answered", lastAuthor: "dev-me" })]));
    const reopened = mine((s) => (pr102(s).threads = [mkThread({ id: "T1" })]));
    const { events } = replay(base(mine()), [seeded, reopened]);
    expect(events.map(summary)).toEqual([[], ["102 thread_pending T1"]]);
  });
});

describe("todo", () => {
  const pr201 = (s: TodoSnapshot) => find(s.prs, 201);
  const pr202 = (s: TodoSnapshot) => find(s.prs, 202);

  test("announces review_requested for a PR new to the baseline", () => {
    const prev = todo((s) => (s.prs = s.prs.filter((p) => p.number !== 201)));
    const { events } = computeEvents(base(prev), todo());
    expect(events).toEqual([
      {
        kind: "review_requested",
        pr: {
          repo: "acme/web",
          number: 201,
          url: "https://github.com/acme/web/pull/201",
          title: "PRJ-2001: add audit log",
          author: "alice",
        },
      },
    ]);
  });

  test("stays silent for a new PR that is not requested from the viewer", () => {
    const prev = todo((s) => (s.prs = s.prs.filter((p) => p.number !== 202)));
    expect(computeEvents(base(prev), todo()).events).toEqual([]);
  });

  test("announces requestedFromMe false -> true", () => {
    const prev = todo((s) => (pr201(s).requestedFromMe = false));
    expect(summary(computeEvents(base(prev), todo()).events)).toEqual(["201 review_requested"]);
  });

  test("does not re-announce true -> true, nor true -> false", () => {
    const { events } = replay(base(todo()), [todo(), todo((s) => (pr201(s).requestedFromMe = false))]);
    expect(events).toEqual([[], []]);
  });

  test("announces a new request on a PR that was previously not requested, then stays quiet", () => {
    const prev = todo();
    const curr = todo((s) => (pr202(s).requestedFromMe = true));
    const { events } = replay(base(prev), [curr, curr]);
    expect(events.map(summary)).toEqual([["202 review_requested"], []]);
  });

  describe("thread_answered", () => {
    const pending = todo((s) => {
      const t = find(pr202(s).threads ?? [], "PRRT_kwDOAAAA10");
      t.state = "pending";
      t.lastAuthor = "dev-me";
      t.commentCount = 1;
    });

    test("announces pending -> answered once, then never again", () => {
      const answered = todo();
      const { events, next } = replay(base(pending), [answered, answered]);
      expect(events.map(summary)).toEqual([["202 thread_answered PRRT_kwDOAAAA10"], []]);
      expect(events[0]?.[0]).toEqual({
        kind: "thread_answered",
        pr: expect.objectContaining({ number: 202, author: "bob" }),
        thread: find(pr202(answered).threads ?? [], "PRRT_kwDOAAAA10"),
      });
      expect(next.missingTicks).toEqual({});
    });

    test("announces a thread that appears already answered on an existing PR", () => {
      const prev = todo((s) => (pr202(s).threads = []));
      expect(summary(computeEvents(base(prev), todo()).events)).toEqual(["202 thread_answered PRRT_kwDOAAAA10"]);
    });

    test("announces answered again after the reviewer re-opens and the owner answers again", () => {
      const reopened = todo((s) => (find(pr202(s).threads ?? [], "PRRT_kwDOAAAA10").state = "pending"));
      const { events } = replay(base(todo()), [reopened, todo()]);
      expect(events.map(summary)).toEqual([[], ["202 thread_answered PRRT_kwDOAAAA10"]]);
    });

    test("suppresses answers written by the viewer", () => {
      const curr = todo((s) => (find(pr202(s).threads ?? [], "PRRT_kwDOAAAA10").lastAuthor = "dev-me"));
      expect(computeEvents(base(pending), curr).events).toEqual([]);
    });

    test("requires the viewer to be the thread opener", () => {
      const curr = todo((s) => (find(pr202(s).threads ?? [], "PRRT_kwDOAAAA10").opener = "alice"));
      expect(computeEvents(base(pending), curr).events).toEqual([]);
    });

    test("is silent for a PR new to the baseline (only review_requested may fire)", () => {
      const prev = todo((s) => (s.prs = []));
      expect(summary(computeEvents(base(prev), todo()).events)).toEqual(["201 review_requested"]);
    });

    test("is silent when the lookup failed, and carries threads forward", () => {
      const failed = todo((s) => (pr202(s).threads = null));
      const { events, next } = replay(base(pending), [failed, todo()]);
      expect(events.map(summary)).toEqual([[], ["202 thread_answered PRRT_kwDOAAAA10"]]);
      expect(next.snapshot.prs).toEqual(todo().prs);
    });

    test("seeds silently on null -> list", () => {
      const prev = todo((s) => (pr202(s).threads = null));
      expect(computeEvents(base(prev), todo()).events).toEqual([]);
    });
  });

  describe("drafts", () => {
    test("never announces review_requested for a draft, new or existing", () => {
      const draftNew = todo((s) => {
        pr201(s).isDraft = true;
      });
      const prev = todo((s) => (s.prs = s.prs.filter((p) => p.number !== 201)));
      expect(computeEvents(base(prev), draftNew).events).toEqual([]);

      const wasNotRequested = todo((s) => (pr201(s).requestedFromMe = false));
      expect(computeEvents(base(wasNotRequested), draftNew).events).toEqual([]);
    });

    test("never announces thread_answered for a draft", () => {
      const prev = todo((s) => {
        find(pr202(s).threads ?? [], "PRRT_kwDOAAAA10").state = "pending";
      });
      const curr = todo((s) => (pr202(s).isDraft = true));
      expect(computeEvents(base(prev), curr).events).toEqual([]);
    });

    test("announces a request that arrived while the PR was a draft once it is ready", () => {
      const draft = todo((s) => (pr201(s).isDraft = true));
      const { events } = replay(base(draft), [draft, todo(), todo()]);
      expect(events.map(summary)).toEqual([[], ["201 review_requested"], []]);
    });
  });
});

describe("PR disappearing from the search results", () => {
  const without = (s: TodoSnapshot, number: number) => {
    s.prs = s.prs.filter((p) => p.number !== number);
    return s;
  };
  const gone = () => without(todo(), 201);

  test("keeps the PR for 1-2 missing ticks and does not re-announce when it returns", () => {
    for (const missing of [1, 2]) {
      const ticks = [...Array.from({ length: missing }, gone), todo()];
      const { events, next } = replay(base(todo()), ticks);
      expect(events.map(summary)).toEqual(ticks.map(() => []));
      expect(next).toEqual({ snapshot: todo(), missingTicks: {} });
    }
  });

  test("counts consecutive missing ticks and retains the PR meanwhile", () => {
    const first = computeEvents(base(todo()), gone());
    expect(first.next.missingTicks).toEqual({ 201: 1 });
    expect(first.next.snapshot.prs.map((p) => p.number)).toEqual([202, 201]);
    const third = replay(base(todo()), [gone(), gone(), gone()]).next;
    expect(third.missingTicks).toEqual({ 201: 3 });
    expect(third.snapshot.prs.map((p) => p.number)).toContain(201);
  });

  test("drops the PR after 3 missing ticks, so it is announced again as new", () => {
    const { events, next } = replay(base(todo()), [gone(), gone(), gone(), gone()]);
    expect(next.missingTicks).toEqual({});
    expect(next.snapshot.prs.map((p) => p.number)).toEqual([202]);
    expect(events.map(summary)).toEqual([[], [], [], []]);
    expect(summary(computeEvents(next, todo()).events)).toEqual(["201 review_requested"]);
  });

  test("restarts the counter after the PR reappears in between", () => {
    const { events, next } = replay(base(todo()), [gone(), gone(), todo(), gone(), gone(), gone(), todo()]);
    expect(events.map(summary)).toEqual([[], [], [], [], [], [], []]);
    expect(next.missingTicks).toEqual({});
  });

  test("diffs a returning mine PR against its retained state", () => {
    const missing = mine((s) => (s.prs = s.prs.filter((p) => p.number !== 101)));
    const back = mine((s) => threadsOf(s, 101).push(mkThread({ id: "NEW" })));
    const { events } = replay(base(mine()), [missing, missing, back]);
    expect(events.map(summary)).toEqual([[], [], ["101 thread_pending NEW"]]);
  });
});

describe("ordering", () => {
  const scenario = () => {
    const prev = mine((s) => {
      for (const pr of s.prs) {
        pr.threads = pr.threads === null ? null : [];
        pr.reviews = [];
      }
      find(s.prs, 102).threads = [];
    });
    const curr = mine((s) => {
      pr101(s).reviews.push(mkReview({ id: "R9", author: "carol", state: "CHANGES_REQUESTED" }), mkReview({ id: "R8" }));
      pr101(s).threads = [mkThread({ id: "T2" }), mkThread({ id: "T1" })];
      pr102(s).threads = [mkThread({ id: "T0" })];
      find(s.prs, 103).threads = [mkThread({ id: "T5" })];
    });
    return { prev, curr };
  };

  const expected = [
    "101 review_approved PRR_kwDOAAAA01",
    "101 review_approved R8",
    "101 review_changes_requested PRR_kwDOAAAA02",
    "101 review_changes_requested R9",
    "101 thread_pending T1",
    "101 thread_pending T2",
    "102 thread_pending T0",
    "103 review_approved PRR_kwDOAAAA03",
    "103 thread_pending T5",
  ];

  test("orders by PR number, then kind, then thread/review id", () => {
    const { prev, curr } = scenario();
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(expected);
  });

  test("does not depend on the order of PRs, threads or reviews in the snapshot", () => {
    const { prev, curr } = scenario();
    curr.prs.reverse();
    for (const pr of curr.prs) {
      pr.reviews.reverse();
      pr.threads?.reverse();
    }
    expect(summary(computeEvents(base(prev), curr).events)).toEqual(expected);
  });
});

describe("mine: ci_failed", () => {
  const ci =
    (state: "pass" | "fail" | "pending" | "none", failedJobs: string[] = [], headOid?: string) =>
    (s: MineSnapshot) => {
      const pr = pr102(s);
      pr.ci = { state, failedJobs };
      if (headOid) pr.headOid = headOid;
    };
  const events102 = (prev: MineSnapshot, curr: MineSnapshot) =>
    computeEvents(base(prev), curr).events.filter((e) => e.pr.number === 102);

  test.each(["pending", "pass", "none"] as const)("announces %s -> fail with the failed job names", (from) => {
    const events = events102(mine(ci(from)), mine(ci("fail", ["build-ui", "e2e"])));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "ci_failed", failedJobs: ["build-ui", "e2e"] });
  });

  test("stays quiet while the same commit keeps failing, even when more jobs fail", () => {
    expect(events102(mine(ci("fail", ["a"])), mine(ci("fail", ["a"])))).toEqual([]);
    expect(events102(mine(ci("fail", ["a"])), mine(ci("fail", ["a", "b"])))).toEqual([]);
  });

  test("announces a failure on a new commit even if no passing or pending state was seen in between", () => {
    const events = events102(mine(ci("fail", ["a"], "old")), mine(ci("fail", ["b"], "new")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "ci_failed", failedJobs: ["b"] });
  });

  test("announces every new failure after a re-run, but not the pending state in between", () => {
    const { events } = replay(base(mine(ci("fail", ["a"]))), [mine(ci("pending")), mine(ci("fail", ["a"]))]);
    expect(events[0]!.filter((e) => e.pr.number === 102)).toEqual([]);
    expect(events[1]!.filter((e) => e.pr.number === 102).map((e) => e.kind)).toEqual(["ci_failed"]);
  });

  test("says nothing when checks recover or finish green", () => {
    expect(events102(mine(ci("fail", ["a"])), mine(ci("pass")))).toEqual([]);
    expect(events102(mine(ci("pending")), mine(ci("pass")))).toEqual([]);
  });

  test("does not announce a PR that is new to the baseline", () => {
    const prev = mine((s) => {
      s.prs = s.prs.filter((p) => p.number !== 102);
    });
    expect(events102(prev, mine(ci("fail", ["a"])))).toEqual([]);
  });

  test("is independent of a failed thread lookup", () => {
    const prev = mine(ci("pending"));
    const curr = mine((s) => {
      ci("fail", ["a"])(s);
      pr102(s).threads = null;
    });
    expect(events102(prev, curr).map((e) => e.kind)).toEqual(["ci_failed"]);
  });
});

// PR 102 has no threads, no reviews and a passing, clean state, so it is the one to put into a given merge status.
type Position = "unapproved" | "pendingThread" | "answeredThread" | "ciFailed" | "ciRunning" | "dirty" | "blocked" | "ready";

function place(position: Position) {
  return (s: MineSnapshot) => {
    const pr = pr102(s);
    pr.approval = { ...pr.approval, decision: position === "unapproved" ? "awaiting" : "approved" };
    pr.ci = {
      state: position === "ciFailed" ? "fail" : position === "ciRunning" ? "pending" : "pass",
      failedJobs: position === "ciFailed" ? ["build"] : [],
    };
    pr.mergeState = position === "dirty" ? "dirty" : position === "blocked" ? "blocked" : "clean";
    pr.pendingReviewers = position === "blocked" ? ["backend"] : [];
    pr.threads =
      position === "pendingThread" || position === "answeredThread"
        ? [
            mkThread({
              id: "TH",
              state: position === "pendingThread" ? "pending" : "answered",
              lastAuthor: position === "pendingThread" ? "alice" : "dev-me",
            }),
          ]
        : [];
  };
}

describe("mine: merge status carried by an approval", () => {
  const statusOf = (editCurr?: (s: MineSnapshot) => void, editPrev?: (s: MineSnapshot) => void) => {
    const prev = mine((s) => {
      pr101(s).reviews = [];
      editPrev?.(s);
    });
    const event = computeEvents(base(prev), mine(editCurr)).events.find((e) => e.kind === "review_approved");
    if (event?.kind !== "review_approved") throw new Error("no approval event");
    return event.status;
  };
  const approved101 = (edit?: (pr: MineSnapshot["prs"][number]) => void) => (s: MineSnapshot) => {
    const pr = pr101(s);
    pr.approval = { ...pr.approval, decision: "approved" };
    pr.ci = { state: "pass", failedJobs: [] };
    pr.mergeState = "clean";
    pr.threads = [];
    edit?.(pr);
  };

  test("is unapproved while the threshold is not met", () => {
    expect(statusOf()).toEqual({ kind: "unapproved" });
  });

  test("lists pending threads, a failing CI and a conflict, and links the earliest pending thread", () => {
    expect(
      statusOf((s) => {
        pr101(s).approval = { ...pr101(s).approval, decision: "approved" };
      })
    ).toEqual({
      kind: "todo",
      pendingThreads: 2,
      firstPendingThreadUrl: "https://github.com/acme/web/pull/101#discussion_r1008",
      ciFailed: true,
      needsRebase: true,
    });
  });

  test("does not count answered or resolved threads", () => {
    const status = statusOf(
      approved101((pr) => {
        pr.threads = [mkThread({ id: "A", state: "answered" }), mkThread({ id: "R", state: "resolved" })];
      })
    );
    expect(status).toEqual({ kind: "ready" });
  });

  test("counts a pending thread opened by a bot", () => {
    const status = statusOf(
      approved101((pr) => {
        pr.threads = [
          mkThread({ id: "B", state: "pending", opener: "coderabbitai", lastAuthor: "coderabbitai", watched: true }),
        ];
      })
    );
    expect(status).toMatchObject({ kind: "todo", pendingThreads: 1 });
  });

  test.each([
    ["dirty", true],
    ["behind", true],
    ["clean", false],
    ["blocked", false],
    ["unstable", false],
    ["has_hooks", false],
  ] as const)("a %s branch needs a rebase: %s", (mergeState, expected) => {
    const status = statusOf(
      approved101((pr) => {
        pr.mergeState = mergeState;
      })
    );
    expect(status.kind === "todo" && status.needsRebase).toBe(expected);
  });

  test("an unknown branch with no earlier answer to keep is still being checked", () => {
    const status = statusOf(
      approved101((pr) => {
        pr.mergeState = "unknown";
      }),
      (s) => {
        pr101(s).mergeState = "unknown";
      }
    );
    expect(status).toEqual({ kind: "checking" });
  });

  test("waits for a running CI", () => {
    expect(
      statusOf(
        approved101((pr) => {
          pr.ci = { state: "pending", failedJobs: [] };
        })
      )
    ).toEqual({ kind: "waiting_ci" });
  });

  test("a failing CI is something to fix, not something to wait for", () => {
    const status = statusOf(
      approved101((pr) => {
        pr.ci = { state: "fail", failedJobs: ["build"] };
      })
    );
    expect(status).toMatchObject({ kind: "todo", ciFailed: true });
  });

  test("reports what GitHub still waits for when everything else is in place", () => {
    const status = statusOf(
      approved101((pr) => {
        pr.mergeState = "blocked";
        pr.pendingReviewers = ["backend", "dave"];
      })
    );
    expect(status).toEqual({ kind: "github_blocked", waitingFor: ["backend", "dave"] });
  });

  test("uses the previous threads when the lookup failed this time", () => {
    const status = statusOf(
      approved101((pr) => {
        pr.threads = null;
      })
    );
    expect(status).toMatchObject({ kind: "todo", pendingThreads: 2 });
  });
});

describe("mine: ready_to_merge and merge_blocked", () => {
  const events102 = (from: Position, to: Position, editCurr?: (s: MineSnapshot) => void) =>
    computeEvents(
      base(mine(place(from))),
      mine((s) => {
        place(to)(s);
        editCurr?.(s);
      })
    ).events.filter((e) => e.pr.number === 102);

  test.each(["unapproved", "pendingThread", "ciFailed", "ciRunning", "dirty", "blocked"] as const)(
    "announces %s -> ready",
    (from) => {
      expect(events102(from, "ready").map((e) => e.kind)).toEqual(["ready_to_merge"]);
    }
  );

  test("a thread that was answered instead of resolved no longer holds the merge back", () => {
    expect(events102("pendingThread", "answeredThread").map((e) => e.kind)).toEqual(["ready_to_merge"]);
  });

  test.each(["ready", "pendingThread", "ciRunning"] as const)(
    "announces %s -> blocked by GitHub, naming the reviewers",
    (from) => {
      const events = events102(from, "blocked");
      if (from === "pendingThread" || from === "ciRunning") {
        expect(events.map((e) => e.kind)).toEqual(["merge_blocked"]);
      } else {
        expect(events).toEqual([expect.objectContaining({ kind: "merge_blocked", waitingFor: ["backend"] })]);
      }
    }
  );

  test.each([
    ["ready", "ready"],
    ["pendingThread", "pendingThread"],
    ["unapproved", "ciFailed"],
    ["ready", "dirty"],
    ["ready", "ciRunning"],
    ["blocked", "blocked"],
    ["unapproved", "unapproved"],
  ] as const)("says nothing for %s -> %s", (from, to) => {
    expect(events102(from, to).filter((e) => e.kind === "ready_to_merge" || e.kind === "merge_blocked")).toEqual([]);
  });

  test("a new approval carries the verdict itself, so no second message follows", () => {
    const events = events102("unapproved", "ready", (s) => {
      pr102(s).reviews = [mkReview({ id: "NEW", author: "carol" })];
    });
    expect(events.map((e) => e.kind)).toEqual(["review_approved"]);
    expect(events[0]).toMatchObject({ status: { kind: "ready" } });

    const blocked = events102("unapproved", "blocked", (s) => {
      pr102(s).reviews = [mkReview({ id: "NEW", author: "carol" })];
    });
    expect(blocked.map((e) => e.kind)).toEqual(["review_approved"]);
  });

  test("is silent for a PR that is new to the baseline", () => {
    const prev = mine((s) => {
      s.prs = s.prs.filter((p) => p.number !== 102);
    });
    const events = computeEvents(base(prev), mine(place("ready"))).events.filter((e) => e.pr.number === 102);
    expect(events).toEqual([]);
  });

  test("does not repeat once the baseline has moved", () => {
    const first = computeEvents(base(mine(place("pendingThread"))), mine(place("ready")));
    expect(first.events.map((e) => e.kind)).toContain("ready_to_merge");
    expect(computeEvents(first.next, mine(place("ready"))).events.filter((e) => e.pr.number === 102)).toEqual([]);
  });
});

describe("mine: GitHub still computing mergeability", () => {
  const unknown = (s: MineSnapshot) => {
    pr102(s).mergeState = "unknown";
  };
  const only102 = (events: ReturnType<typeof computeEvents>["events"]) => events.filter((e) => e.pr.number === 102);
  const mergeStateOf = (result: ReturnType<typeof computeEvents>) =>
    (result.next.snapshot as MineSnapshot).prs.find((p) => p.number === 102)!.mergeState;

  test("a conflict stays a conflict while GitHub answers unknown", () => {
    const result = computeEvents(
      base(mine(place("dirty"))),
      mine((s) => {
        place("ready")(s);
        unknown(s);
      })
    );
    expect(only102(result.events)).toEqual([]);
    expect(mergeStateOf(result)).toBe("dirty");
  });

  test("announces the PR once GitHub settles on a clean state", () => {
    const first = computeEvents(
      base(mine(place("dirty"))),
      mine((s) => {
        place("ready")(s);
        unknown(s);
      })
    );
    expect(only102(computeEvents(first.next, mine(place("ready"))).events).map((e) => e.kind)).toEqual(["ready_to_merge"]);
  });

  test("a ready PR is not announced again after an unknown poll", () => {
    const afterUnknown = computeEvents(
      base(mine(place("ready"))),
      mine((s) => {
        place("ready")(s);
        unknown(s);
      })
    );
    expect(only102(afterUnknown.events)).toEqual([]);
    expect(only102(computeEvents(afterUnknown.next, mine(place("ready"))).events)).toEqual([]);
  });

  test("does not call a PR ready on an unknown state after a new commit", () => {
    const result = computeEvents(
      base(mine(place("dirty"))),
      mine((s) => {
        place("ready")(s);
        unknown(s);
        pr102(s).headOid = "new-head";
      })
    );
    expect(only102(result.events)).toEqual([]);
    expect(mergeStateOf(result)).toBe("unknown");
  });

  test("an approval seen while GitHub is checking says so instead of promising a merge", () => {
    const events = only102(
      computeEvents(
        base(mine(place("unapproved"))),
        mine((s) => {
          place("ready")(s);
          unknown(s);
          pr102(s).headOid = "new-head";
          pr102(s).reviews = [mkReview({ id: "NEW", author: "carol" })];
        })
      ).events
    );
    expect(events).toEqual([expect.objectContaining({ kind: "review_approved", status: { kind: "checking" } })]);
  });
});

describe("mine: approvals made before the latest commits", () => {
  const stale = (s: MineSnapshot) => {
    pr102(s).approval = { ...pr102(s).approval, approvers: [], staleApprovers: ["alice", "carol"], decision: "approved_stale" };
  };
  const events102 = (from: Position, to: Position, editCurr?: (s: MineSnapshot) => void) =>
    computeEvents(
      base(mine(place(from))),
      mine((s) => {
        place(to)(s);
        editCurr?.(s);
      })
    ).events.filter((e) => e.pr.number === 102);

  test("still count, so the PR is announced as ready and carries the stale approvals", () => {
    const events = events102("dirty", "ready", stale);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "ready_to_merge",
        approval: expect.objectContaining({ staleApprovers: ["alice", "carol"], decision: "approved_stale" }),
      }),
    ]);
  });

  test("an approval that meets the threshold only with stale ones carries the verdict", () => {
    const events = events102("unapproved", "ready", (s) => {
      stale(s);
      pr102(s).reviews = [mkReview({ id: "NEW", author: "carol" })];
    });
    expect(events).toEqual([expect.objectContaining({ kind: "review_approved", status: { kind: "ready" } })]);
  });

  test("turning stale after a push is not an event by itself", () => {
    expect(events102("ready", "ready", stale)).toEqual([]);
  });

  test("a PR that stays below the threshold is still unapproved", () => {
    const awaiting = (s: MineSnapshot) => {
      pr102(s).approval = { ...pr102(s).approval, approvers: [], staleApprovers: ["alice"], decision: "awaiting" };
    };
    expect(events102("unapproved", "ready", awaiting)).toEqual([]);
  });
});

describe("mine: Jira merge gate", () => {
  const gate = { statuses: ["Merge"] };
  const ticket =
    (status: string | null, key = "PRJ-1002") =>
    (s: MineSnapshot) => {
      pr102(s).jira = { key, url: `https://jira.example/browse/${key}`, status };
    };
  const noTicket = (s: MineSnapshot) => {
    pr102(s).jira = null;
  };
  const apply =
    (...edits: ((s: MineSnapshot) => void)[]) =>
    (s: MineSnapshot) => {
      for (const edit of edits) edit(s);
    };
  const run = (
    from: [Position, (s: MineSnapshot) => void],
    to: [Position, (s: MineSnapshot) => void],
    options: { gate?: typeof gate | undefined; editCurr?: (s: MineSnapshot) => void } = {}
  ) => {
    const prev = base(mine(apply(place(from[0]), from[1])));
    const curr = mine(apply(place(to[0]), to[1], options.editCurr ?? (() => {})));
    return computeEvents(prev, curr, "gate" in options ? options.gate : gate);
  };
  const only102 = (events: NotifyEvent[]) => events.filter((e) => e.pr.number === 102);
  const newApproval = (s: MineSnapshot) => {
    pr102(s).reviews = [mkReview({ id: "NEW", author: "carol" })];
  };

  test("an approval that clears every blocker waits while the ticket is not in the merge status", () => {
    const { events } = run(["unapproved", ticket("Review")], ["ready", ticket("Review")], { editCurr: newApproval });
    expect(only102(events)).toEqual([
      expect.objectContaining({
        kind: "review_approved",
        status: {
          kind: "waiting_jira",
          ticket: expect.objectContaining({ key: "PRJ-1002", status: "Review" }),
          wanted: ["Merge"],
        },
      }),
    ]);
  });

  test("an approval is ready at once when the ticket is already in the merge status, in any letter case", () => {
    for (const status of ["Merge", "merge", " MERGE "]) {
      const { events } = run(["unapproved", ticket(status)], ["ready", ticket(status)], { editCurr: newApproval });
      expect(only102(events)).toEqual([expect.objectContaining({ kind: "review_approved", status: { kind: "ready" } })]);
    }
  });

  test("blockers still come first: a pending thread is something to resolve, not a reason to wait for Jira", () => {
    const { events } = run(["unapproved", ticket("Review")], ["pendingThread", ticket("Review")], { editCurr: newApproval });
    expect(only102(events).find((e) => e.kind === "review_approved")).toMatchObject({ status: { kind: "todo" } });
  });

  test("blockers clearing after the approval say the review passed instead of announcing the merge", () => {
    for (const from of ["pendingThread", "ciFailed", "ciRunning", "dirty", "blocked"] as const) {
      const { events } = run([from, ticket("Review")], ["ready", ticket("Review")]);
      expect(only102(events)).toEqual([
        expect.objectContaining({ kind: "review_passed", status: expect.objectContaining({ kind: "waiting_jira" }) }),
      ]);
    }
  });

  test("the ticket reaching the merge status announces the merge when nothing else is in the way", () => {
    const { events } = run(["ready", ticket("Approved")], ["ready", ticket("Merge")]);
    expect(only102(events)).toEqual([
      expect.objectContaining({
        kind: "ticket_in_merge",
        ticket: expect.objectContaining({ status: "Merge" }),
        status: { kind: "ready" },
        approval: expect.objectContaining({ decision: "approved" }),
      }),
    ]);
  });

  test("the ticket reaching the merge status names what still blocks the PR", () => {
    const { events } = run(["pendingThread", ticket("Approved")], ["pendingThread", ticket("Merge")]);
    expect(only102(events)).toEqual([
      expect.objectContaining({
        kind: "ticket_in_merge",
        status: expect.objectContaining({ kind: "todo", pendingThreads: 1 }),
      }),
    ]);
    const blocked = run(["blocked", ticket("Approved")], ["blocked", ticket("Merge")]).events;
    expect(only102(blocked)).toEqual([
      expect.objectContaining({ kind: "ticket_in_merge", status: { kind: "github_blocked", waitingFor: ["backend"] } }),
    ]);
  });

  test("the ticket reaching the merge status of a PR that is not approved yet is reported as such", () => {
    const { events } = run(["unapproved", ticket("Review")], ["unapproved", ticket("Merge")]);
    expect(only102(events)).toEqual([expect.objectContaining({ kind: "ticket_in_merge", status: { kind: "unapproved" } })]);
  });

  test("a ticket moved back out of the merge status says the PR waits again", () => {
    const { events } = run(["ready", ticket("Merge")], ["ready", ticket("Approved")]);
    expect(only102(events)).toEqual([expect.objectContaining({ kind: "review_passed" })]);
  });

  test("blockers clearing while the ticket is in the merge status announce the merge again, naming the ticket", () => {
    const { events } = run(["pendingThread", ticket("Merge")], ["ready", ticket("Merge")]);
    expect(only102(events)).toEqual([
      expect.objectContaining({
        kind: "ready_to_merge",
        ticket: expect.objectContaining({ key: "PRJ-1002", status: "Merge" }),
      }),
    ]);
  });

  test("the whole path: moved to Merge with a blocker, then the blocker clears", () => {
    const first = run(["pendingThread", ticket("Approved")], ["pendingThread", ticket("Merge")]);
    expect(only102(first.events).map((e) => e.kind)).toEqual(["ticket_in_merge"]);
    const next = computeEvents(first.next, mine(apply(place("ready"), ticket("Merge"))), gate);
    expect(only102(next.events).map((e) => e.kind)).toEqual(["ready_to_merge"]);
  });

  test("an approval and the move to the merge status in the same poll give one message, the approval", () => {
    const { events } = run(["unapproved", ticket("Review")], ["ready", ticket("Merge")], { editCurr: newApproval });
    expect(only102(events)).toEqual([expect.objectContaining({ kind: "review_approved", status: { kind: "ready" } })]);
  });

  test("stays quiet on the next poll", () => {
    const first = run(["ready", ticket("Approved")], ["ready", ticket("Merge")]);
    expect(only102(first.events)).not.toEqual([]);
    expect(only102(computeEvents(first.next, mine(apply(place("ready"), ticket("Merge"))), gate).events)).toEqual([]);
  });

  test("without a gate the ticket is ignored", () => {
    const { events } = run(["pendingThread", ticket("Review")], ["ready", ticket("Review")], { gate: undefined });
    expect(only102(events)).toEqual([expect.objectContaining({ kind: "ready_to_merge" })]);
    expect(only102(events)[0]).not.toHaveProperty("ticket");
  });

  test("a PR without a ticket is announced as ready as usual", () => {
    const { events } = run(["pendingThread", noTicket], ["ready", noTicket]);
    expect(only102(events).map((e) => e.kind)).toEqual(["ready_to_merge"]);
  });

  test("a failed lookup keeps the last known status of the same ticket", () => {
    const first = run(["ready", ticket("Merge")], ["ready", ticket(null)]);
    expect(only102(first.events)).toEqual([]);
    expect(find(first.next.snapshot.prs as MineSnapshot["prs"], 102).jira?.status).toBe("Merge");
  });

  test("a status that was never known keeps the PR waiting and says so", () => {
    const { events } = run(["pendingThread", ticket(null)], ["ready", ticket(null)]);
    expect(only102(events)).toEqual([
      expect.objectContaining({
        kind: "review_passed",
        status: expect.objectContaining({ ticket: expect.objectContaining({ status: null }) }),
      }),
    ]);
  });

  test("announces nothing when the ticket is first seen, for example right after Jira was switched on", () => {
    const { events } = run(["ready", (s) => delete pr102(s).jira], ["ready", ticket("Review")]);
    expect(only102(events)).toEqual([]);
    const merge = run(["ready", (s) => delete pr102(s).jira], ["ready", ticket("Merge")]).events;
    expect(only102(merge)).toEqual([]);
  });

  test("a different ticket key does not count as a move", () => {
    const { events } = run(["ready", ticket("Review", "PRJ-1")], ["ready", ticket("Merge", "PRJ-2")]);
    expect(only102(events)).toEqual([]);
  });

  test("a PR that is new to the baseline stays silent", () => {
    const prev = mine((s) => {
      s.prs = s.prs.filter((p) => p.number !== 102);
    });
    const curr = mine(apply(place("ready"), ticket("Merge")));
    expect(only102(computeEvents(base(prev), curr, gate).events)).toEqual([]);
  });
});
