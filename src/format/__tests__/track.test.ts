import { describe, expect, test } from "vitest";
import { parseSnapshot, type TrackSnapshot } from "../../contract/snapshot.js";
import type { NotifyEvent, PrRef } from "../../diff/diff.js";
import { readFixture } from "../../__tests__/fixtures.js";
import { formatEvents } from "../format.js";

const snapshot = parseSnapshot(readFixture("track")) as TrackSnapshot;
const pr = snapshot.prs[0]!;
const ticket = { key: "PRJ-2001", url: "https://acme.atlassian.net/browse/PRJ-2001", status: "Approved" };
const ref: PrRef = { repo: snapshot.repo, number: pr.number, url: pr.url, title: pr.title, author: pr.author, tracked: true };
const passing = { ...pr.approval, approvers: ["carol", "dan"], changesRequestedBy: [], decision: "approved" as const };

const one = (event: NotifyEvent) => formatEvents([event])[0]!;

describe("tracked PRs", () => {
  test("lead with the event, then the PR marked as tracked with its author", () => {
    expect(one({ kind: "tracked_merged", pr: ref }).text).toBe(
      '🟣 <b>Merged</b>\n📌 <a href="https://github.com/acme/web/pull/201"><b>#201</b></a> PRJ-2001: add an audit log · alice'
    );
  });

  test("make a sound for a new PR, a passed review, a merge and a close only", () => {
    const loud: NotifyEvent[] = [
      { kind: "tracked_new_pr", pr: ref, ticket },
      { kind: "tracked_passed", pr: ref, approval: passing, by: ["dan"] },
      { kind: "tracked_merged", pr: ref },
      { kind: "tracked_closed", pr: ref },
    ];
    const quiet: NotifyEvent[] = [
      { kind: "tracked_ci_passed", pr: ref },
      { kind: "tracked_conflicts", pr: ref },
      { kind: "tracked_ticket_moved", pr: ref, ticket, from: "In Review" },
      { kind: "ci_failed", pr: ref, failedJobs: ["build"] },
      { kind: "review_changes_requested", pr: ref, review: pr.reviews[1]!, approval: pr.approval },
      { kind: "review_approved", pr: ref, review: pr.reviews[0]!, approval: passing, status: { kind: "unapproved" } },
      { kind: "thread_pending", pr: ref, thread: pr.threads![0]! },
    ];
    expect(loud.map((e) => one(e).silent)).toEqual([false, false, false, false]);
    expect(quiet.map((e) => one(e).silent)).toEqual(quiet.map(() => true));
  });

  test("say what happened in a word or two", () => {
    const text = (e: NotifyEvent) => one(e).text.split("\n")[0];
    expect(text({ kind: "tracked_new_pr", pr: ref, ticket })).toBe(
      '🆕 New PR for <a href="https://acme.atlassian.net/browse/PRJ-2001">PRJ-2001</a>'
    );
    expect(text({ kind: "tracked_passed", pr: ref, approval: passing, by: ["dan"] })).toBe(
      "✅ <b>Review passed</b> · <b>dan</b> approved · 2/2"
    );
    expect(text({ kind: "tracked_passed", pr: ref, approval: passing, by: [] })).toBe("✅ <b>Review passed</b> · 2/2");
    expect(text({ kind: "tracked_closed", pr: ref })).toBe("✖️ Closed without merging");
    expect(text({ kind: "tracked_ticket_moved", pr: ref, ticket, from: "In Review" })).toBe(
      '🎫 <a href="https://acme.atlassian.net/browse/PRJ-2001">PRJ-2001</a>: <i>In Review</i> → <i>Approved</i>'
    );
  });

  test("show a thread as one short line without the quote", () => {
    const text = one({ kind: "thread_pending", pr: ref, thread: pr.threads![0]! }).text;
    expect(text.split("\n")[0]).toMatch(/^💬 <b>alice<\/b> <a href="[^"]+">opened a thread<\/a>$/);
    expect(text).not.toContain("<blockquote>");
  });

  test("give an approval below the threshold no merge verdict", () => {
    const below = { ...pr.approval, approvers: ["carol"], decision: "awaiting" as const };
    const text = one({
      kind: "review_approved",
      pr: ref,
      review: pr.reviews[0]!,
      approval: below,
      status: { kind: "unapproved" },
    });
    expect(text.text.split("\n")[0]).toBe("✅ <b>alice</b> approved · 1/2");
  });
});
