import { describe, expect, test } from "vitest";
import { parseSnapshot, type TrackSnapshot } from "../../contract/snapshot.js";
import { parseRef } from "../../config/tracked.js";
import { readFixture } from "../../__tests__/fixtures.js";
import { isDone, renderTracked, renderTrackedParts, shownPrs } from "../tracked.js";

const snapshot = parseSnapshot(readFixture("track")) as TrackSnapshot;
const now = new Date(Date.parse(snapshot.generatedAt) + 60_000);
const entries = (...refs: string[]) => refs.map((r) => parseRef(r)!);
const plain = (html: string) => html.replace(/<[^>]+>/g, "");

describe("renderTracked", () => {
  test("shows a ticket with its open PRs, a ticket with none yet and a merged PR, in the list's order", () => {
    const [page] = renderTracked(entries("PRJ-2001", "203", "PRJ-2050"), snapshot, { now, timeZone: "UTC" });
    expect(plain(page!).split("\n\n")).toEqual([
      "📌 Tracked · 3 · 10:00",
      [
        "🎫 PRJ-2001 · In Review",
        "#201 PRJ-2001: add an audit log · alice",
        "🔄 changes requested by bob · 💬 2 open threads · ❌ CI failed · 🔀 conflicts · 1/2 · 4d",
        "#202 PRJ-2001: audit log page · bob",
        "⏳ needs approvals · 0/2 · 3d",
      ].join("\n"),
      "#203 PRJ-1990: rename the settings tab · carol\n🟣 merged 25h ago",
      "🎫 PRJ-2050 · To Do\nno PR yet",
    ]);
  });

  test("says when an entry is not in the poll", () => {
    const [page] = renderTracked(entries("99999", "XYZ-1"), snapshot, { now });
    expect(plain(page!)).toContain("#99999\n⚠️ not in the repo (or not loaded yet)");
    expect(plain(page!)).toContain("🎫 XYZ-1\n⚠️ skipped by gh-pr-tools (another Jira prefix?)");
    const old = { ...snapshot };
    delete old.tickets;
    expect(plain(renderTracked(entries("PRJ-2001"), old, { now })[0]!)).toContain("this gh-pr-tools does not take tickets");
  });

  test("gives each profile that follows something its own section", () => {
    const [page] = renderTrackedParts(
      [
        { profile: "web", entries: entries("203"), snapshot },
        { profile: "api", entries: [], snapshot: null },
        { profile: "ops", entries: entries("OPS-1"), snapshot: null },
      ],
      { now, timeZone: "UTC" }
    );
    expect(plain(page!).split("\n\n")).toEqual([
      "📌 Tracked · 2 · 10:00",
      "🗂 web\n#203 PRJ-1990: rename the settings tab · carol\n🟣 merged 25h ago",
      "\n🗂 ops\n🎫 OPS-1\n⚠️ not loaded yet",
    ]);
  });

  test("invites to add something when the list is empty", () => {
    expect(renderTracked([], null, { now })[0]).toContain("Nothing tracked yet");
  });

  test("shows the review as passed and a PR entry with its ticket status", () => {
    const passed = structuredClone(snapshot);
    const pr = passed.prs.find((p) => p.number === 202)!;
    pr.approval = { ...pr.approval, approvers: ["carol", "dan"], decision: "approved" };
    expect(plain(renderTracked(entries("202"), passed, { now })[0]!)).toContain("✅ review passed · 2/2 · 🎫 In Review · 3d");
  });
});

describe("what a ticket shows and what is done", () => {
  const tickets = new Map(snapshot.prs.map((p) => [p.number, p]));

  test("a ticket shows its open PRs, else the last merged one", () => {
    expect(shownPrs(snapshot.tickets![0]!, tickets).map((p) => p.number)).toEqual([201, 202]);
    expect(
      shownPrs({ key: "X-1", url: null, status: null, prs: [203, 202] }, new Map([[203, tickets.get(203)!]])).map(
        (p) => p.number
      )
    ).toEqual([203]);
  });

  test("a merged PR and a ticket whose PRs all merged are done; a ticket without PRs is not", () => {
    const done = structuredClone(snapshot);
    for (const p of done.prs) p.state = "merged";
    expect(entries("203", "PRJ-2001", "PRJ-2050", "201").map((e) => isDone(e, snapshot))).toEqual([true, false, false, false]);
    expect(entries("PRJ-2001", "PRJ-2050").map((e) => isDone(e, done))).toEqual([true, false]);
  });
});
