import { describe, expect, test } from "vitest";
import { ContractError, parseSnapshot } from "../snapshot.js";
import { readFixture as fixture } from "../../__tests__/fixtures.js";

describe("parseSnapshot", () => {
  test("accepts the mine fixture, including failed and truncated thread lookups", () => {
    const snapshot = parseSnapshot(fixture("mine"));
    expect(snapshot.command).toBe("mine");
    expect(snapshot.prs.map((pr) => pr.threads?.length ?? null)).toEqual([4, null, 0]);
    expect(snapshot.prs[2]?.threadsTruncated).toBe(true);
  });

  test("accepts the todo fixture and exposes requestedFromMe", () => {
    const snapshot = parseSnapshot(fixture("todo"));
    if (snapshot.command !== "todo") throw new Error("expected todo");
    expect(snapshot.prs.map((pr) => pr.requestedFromMe)).toEqual([true, false]);
  });

  test("ignores unknown fields so gh-pr-tools can add data without a version bump", () => {
    const raw = fixture("mine");
    raw.extra = 1;
    raw.prs[0].extra = 1;
    raw.prs[0].threads[0].extra = 1;
    expect(() => parseSnapshot(raw)).not.toThrow();
  });

  test("rejects another schemaVersion with an upgrade hint", () => {
    const raw = fixture("mine");
    raw.schemaVersion = 2;
    expect(() => parseSnapshot(raw)).toThrow(/unsupported schemaVersion 2.*update/);
  });

  test("rejects non-object input as an unsupported version", () => {
    expect(() => parseSnapshot(null)).toThrow(ContractError);
    expect(() => parseSnapshot("oops")).toThrow(ContractError);
  });

  test("rejects an unknown thread state", () => {
    const raw = fixture("mine");
    raw.prs[0].threads[0].state = "open";
    expect(() => parseSnapshot(raw)).toThrow(/invalid snapshot/);
  });

  test("rejects a todo PR without requestedFromMe", () => {
    const raw = fixture("todo");
    delete raw.prs[0].requestedFromMe;
    expect(() => parseSnapshot(raw)).toThrow(/requestedFromMe/);
  });

  test("requires ci on mine PRs, with a known state", () => {
    const missing = fixture("mine");
    delete missing.prs[0].ci;
    expect(() => parseSnapshot(missing)).toThrow(/ci/);
    const unknown = fixture("mine");
    unknown.prs[0].ci.state = "failed";
    expect(() => parseSnapshot(unknown)).toThrow(/invalid snapshot/);
    expect(parseSnapshot(fixture("mine")).prs.map((p) => ("ci" in p ? p.ci.state : null))).toEqual(["fail", "pass", "pending"]);
  });

  test("requires a known mergeState on mine PRs", () => {
    const missing = fixture("mine");
    delete missing.prs[0].mergeState;
    expect(() => parseSnapshot(missing)).toThrow(/mergeState/);
    const unknown = fixture("mine");
    unknown.prs[0].mergeState = "conflicting";
    expect(() => parseSnapshot(unknown)).toThrow(/invalid snapshot/);
  });

  test("requires the pending reviewers on mine PRs", () => {
    const missing = fixture("mine");
    delete missing.prs[0].pendingReviewers;
    expect(() => parseSnapshot(missing)).toThrow(/pendingReviewers/);
    const wrong = fixture("mine");
    wrong.prs[0].pendingReviewers = [1];
    expect(() => parseSnapshot(wrong)).toThrow(/invalid snapshot/);
  });

  test("does not expect ci on todo PRs", () => {
    expect(() => parseSnapshot(fixture("todo"))).not.toThrow();
  });

  test("rejects a repo that is not owner/name", () => {
    const raw = fixture("mine");
    raw.repo = "acme";
    expect(() => parseSnapshot(raw)).toThrow(/repo/);
  });
});
