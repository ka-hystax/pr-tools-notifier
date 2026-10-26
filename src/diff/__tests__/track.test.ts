import { describe, expect, test } from "vitest";
import { parseSnapshot, type Review, type TrackPullRequest, type TrackSnapshot } from "../../contract/snapshot.js";
import { readFixture } from "../../__tests__/fixtures.js";
import { computeEvents, trackedPassed, type Baseline, type NotifyEvent } from "../diff.js";

function track(edit?: (s: TrackSnapshot) => void): TrackSnapshot {
  const s = parseSnapshot(readFixture("track")) as TrackSnapshot;
  edit?.(s);
  return s;
}

const pr = (s: TrackSnapshot, number: number): TrackPullRequest => s.prs.find((p) => p.number === number)!;
const base = (snapshot: TrackSnapshot): Baseline => ({ snapshot, missingTicks: {} });

const review = (o: Partial<Review> & Pick<Review, "id">): Review => ({
  author: "carol",
  state: "APPROVED",
  submittedAt: "2026-10-13T11:00:00Z",
  commitOid: null,
  ...o,
});

function summary(events: NotifyEvent[]): string[] {
  return events.map((e) => `${e.pr.number} ${e.kind}`);
}

function diff(edit: (s: TrackSnapshot) => void, options: { skipOwn?: boolean } = {}) {
  return computeEvents(base(track()), track(edit), undefined, options);
}

// Two approvals of a threshold of 2, nobody asking for changes.
function passing(p: TrackPullRequest): void {
  p.approval = { ...p.approval, approvers: ["carol", "dan"], changesRequestedBy: [], decision: "approved" };
}

describe("track: seeding", () => {
  test("says nothing on the first run", () => {
    expect(computeEvents(null, track()).events).toEqual([]);
  });

  test("says nothing about a PR new to the baseline", () => {
    const old = track((s) => (s.prs = s.prs.filter((p) => p.number !== 202)));
    expect(
      computeEvents(
        base(old),
        track((s) => passing(pr(s, 202)))
      ).events
    ).toEqual([]);
  });

  test("marks every event's PR as tracked", () => {
    const { events } = diff((s) => (pr(s, 202).state = "merged"));
    expect(events.map((e) => e.pr.tracked)).toEqual([true]);
  });
});

describe("track: a PR's own changes", () => {
  test("announces a merge and a close, and nothing else about that PR", () => {
    const { events } = diff((s) => {
      pr(s, 201).state = "merged";
      pr(s, 201).ci.state = "fail";
      pr(s, 202).state = "closed";
    });
    expect(summary(events)).toEqual(["201 tracked_merged", "202 tracked_closed"]);
  });

  test("says nothing about a PR that was already merged", () => {
    expect(diff((s) => (pr(s, 203).ci.state = "fail")).events).toEqual([]);
  });

  test("announces that the review passed when the threshold is met and nobody asks for changes", () => {
    const { events } = diff((s) => {
      passing(pr(s, 202));
      pr(s, 202).reviews.push(review({ id: "R1" }), review({ id: "R2", author: "dan" }));
    });
    expect(events).toMatchObject([{ kind: "tracked_passed", by: ["carol", "dan"] }]);
  });

  test("announces a passed review without new approvals when a change request goes away", () => {
    const old = track((s) => {
      passing(pr(s, 202));
      pr(s, 202).approval.changesRequestedBy = ["erin"];
    });
    const { events } = computeEvents(
      base(old),
      track((s) => passing(pr(s, 202)))
    );
    expect(events).toMatchObject([{ kind: "tracked_passed", by: [] }]);
  });

  test("does not count CI or conflicts against a passed review", () => {
    const p = track((s) => {
      passing(pr(s, 202));
      pr(s, 202).ci.state = "fail";
      pr(s, 202).mergeState = "dirty";
    });
    expect(trackedPassed(pr(p, 202))).toBe(true);
    expect(trackedPassed({ ...pr(p, 202), isDraft: true })).toBe(false);
  });

  test("reports an approval below the threshold, with no merge verdict", () => {
    const { events } = diff((s) => pr(s, 202).reviews.push(review({ id: "R1" })));
    expect(events).toMatchObject([{ kind: "review_approved", status: { kind: "unapproved" } }]);
  });

  test("reports changes requested, a new failure, a recovery and new conflicts", () => {
    const old = track((s) => (pr(s, 202).ci.state = "fail"));
    const { events } = computeEvents(
      base(old),
      track((s) => {
        pr(s, 202).ci.state = "pass";
        pr(s, 202).mergeState = "dirty";
        pr(s, 202).reviews.push(review({ id: "R1", state: "CHANGES_REQUESTED" }));
        pr(s, 201).headOid = "new";
        pr(s, 201).ci.state = "fail";
      })
    );
    expect(summary(events)).toEqual([
      "201 ci_failed",
      "202 review_changes_requested",
      "202 tracked_ci_passed",
      "202 tracked_conflicts",
    ]);
  });

  test("does not report CI that passes without having failed", () => {
    const old = track((s) => (pr(s, 202).ci.state = "pending"));
    expect(
      computeEvents(
        base(old),
        track((s) => (pr(s, 202).ci.state = "pass"))
      ).events
    ).toEqual([]);
  });

  test("reports a thread opened by someone else, not one by the viewer", () => {
    const { events } = diff((s) => {
      pr(s, 201).threads!.push(
        { ...pr(s, 201).threads![0]!, id: "T1", lastAuthor: "carol" },
        { ...pr(s, 201).threads![0]!, id: "T2", lastAuthor: "dev-me" }
      );
    });
    expect(events).toMatchObject([{ kind: "thread_pending", thread: { id: "T1" } }]);
  });

  test("leaves the viewer's own PRs to mine", () => {
    const edit = (s: TrackSnapshot) => {
      pr(s, 202).author = "dev-me";
      pr(s, 202).state = "merged";
    };
    expect(diff(edit, { skipOwn: true }).events).toEqual([]);
    expect(summary(diff(edit).events)).toEqual(["202 tracked_merged"]);
  });
});

describe("track: tickets", () => {
  const withNewPr = (s: TrackSnapshot) => {
    s.prs.push({ ...pr(s, 202), number: 204, url: "https://github.com/acme/web/pull/204", author: "erin" });
    s.tickets![0]!.prs.push(204);
  };

  test("announces a PR the ticket did not have before", () => {
    const { events } = diff(withNewPr);
    expect(events).toMatchObject([
      { kind: "tracked_new_pr", pr: { number: 204, author: "erin" }, ticket: { key: "PRJ-2001" } },
    ]);
  });

  test("says nothing about the PRs of a ticket seen for the first time", () => {
    const old = track((s) => (s.tickets = s.tickets!.filter((t) => t.key !== "PRJ-2001")));
    expect(computeEvents(base(old), track(withNewPr)).events).toEqual([]);
  });

  test("says nothing when the earlier gh-pr-tools did not report tickets", () => {
    const old = track((s) => delete s.tickets);
    expect(computeEvents(base(old), track(withNewPr)).events).toEqual([]);
  });

  test("does not announce a new PR that has already merged", () => {
    const { events } = diff((s) => {
      withNewPr(s);
      pr(s, 204).state = "merged";
    });
    expect(events).toEqual([]);
  });

  test("reports a status move on the ticket's first open PR", () => {
    const { events } = diff((s) => (s.tickets![0]!.status = "Approved"));
    expect(events).toMatchObject([
      { kind: "tracked_ticket_moved", pr: { number: 201 }, from: "In Review", ticket: { status: "Approved" } },
    ]);
  });

  test("says nothing about a move of a ticket without PRs", () => {
    expect(diff((s) => (s.tickets![1]!.status = "In Progress")).events).toEqual([]);
  });

  test("keeps the last known status through a failed Jira lookup, so the return is no move", () => {
    const first = computeEvents(
      base(track()),
      track((s) => (s.tickets![0]!.status = null))
    );
    expect(first.events).toEqual([]);
    expect(first.next.snapshot.command === "track" && first.next.snapshot.tickets![0]!.status).toBe("In Review");
    expect(computeEvents(first.next, track()).events).toEqual([]);
  });
});
