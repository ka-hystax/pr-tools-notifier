import { describe, expect, test } from "vitest";
import { parseSnapshot, type MineSnapshot, type TodoSnapshot } from "../../contract/snapshot.js";
import { readFixture } from "../../__tests__/fixtures.js";
import { MAX_MESSAGE_LENGTH } from "../../format/format.js";
import { ago, renderList } from "../views.js";

const mine = parseSnapshot(readFixture("mine")) as MineSnapshot;
const todo = parseSnapshot(readFixture("todo")) as TodoSnapshot;
const NOW = new Date(Date.parse(mine.generatedAt) + 30_000);
const options = { now: NOW, timeZone: "UTC" };

type MinePr = MineSnapshot["prs"][number];
type TodoPr = TodoSnapshot["prs"][number];

// PR 102 of the fixture: no threads, passing CI, clean, awaiting approval.
const base = mine.prs.find((p) => p.number === 102)!;
let counter = 1000;
function minePr(over: Partial<MinePr> = {}): MinePr {
  counter += 1;
  return {
    ...structuredClone(base),
    number: counter,
    url: `https://github.com/acme/web/pull/${counter}`,
    title: `T${counter}`,
    ...over,
  };
}
const approved = (over: Partial<MinePr> = {}) =>
  minePr({ approval: { ...base.approval, approvers: ["a", "b"], decision: "approved" }, ...over });

function listOf(prs: MinePr[], extra: Parameters<typeof renderList>[1] = options): string[] {
  return renderList({ ...mine, prs }, extra);
}

const plain = (html: string) => html.replace(/<\/?(b|i|code)>/g, "").replace(/<a href="[^"]*">([^<]*)<\/a>/g, "$1");
const firstPage = (prs: MinePr[], extra?: Parameters<typeof renderList>[1]) => plain(listOf(prs, extra)[0]!);

describe("ago", () => {
  test.each([
    [0, "0m"],
    [59 * 60_000, "59m"],
    [60 * 60_000, "1h"],
    [47 * 3_600_000, "47h"],
    [48 * 3_600_000, "2d"],
    [-5_000, "0m"],
  ])("%d ms is %s", (ms, text) => {
    expect(ago(new Date(NOW.getTime() - ms).toISOString(), NOW)).toBe(text);
  });
});

describe("mine rows", () => {
  test("the fixture reads as expected, most broken first", () => {
    const text = plain(renderList(mine, options)[0]!);
    expect(text).toMatch(/^📤 Mine · 3 PRs · 10:00\n\n🔴 #101 /);
    expect(text).toContain("changes requested by bob · CI failed · 2 threads · needs a rebase · 1/2 · 4d");
    expect(text).toContain("⏳ #102 PRJ-1002: fix locale fallback\nneeds approval · 0/2 · 3d");
    expect(text).toContain("📝 #103");
  });

  test("an approved, clean PR is ready to merge and comes first", () => {
    const text = firstPage([minePr({ ci: { state: "fail", failedJobs: ["x"] } }), approved()]);
    expect(text.indexOf("🟢")).toBeGreaterThan(-1);
    expect(text.indexOf("🟢")).toBeLessThan(text.indexOf("🔴"));
    expect(text).toContain("ready to merge · 2/2");
  });

  test("lists what to fix, linking the checks and the first pending thread", () => {
    const [html] = listOf([
      minePr({
        ci: { state: "fail", failedJobs: ["build"] },
        threads: [
          {
            id: "A",
            state: "pending",
            opener: "x",
            lastAuthor: "x",
            watched: false,
            commentCount: 1,
            path: null,
            url: "https://t/late",
            lastCommentAt: "2026-10-13T10:00:00Z",
            excerpt: "",
          },
          {
            id: "B",
            state: "pending",
            opener: "x",
            lastAuthor: "x",
            watched: false,
            commentCount: 1,
            path: null,
            url: "https://t/early",
            lastCommentAt: "2026-10-13T09:00:00Z",
            excerpt: "",
          },
        ],
      }),
    ]);
    expect(html).toContain('<a href="https://github.com/acme/web/pull/1');
    expect(html).toMatch(/<a href="[^"]+\/checks">CI failed<\/a>/);
    expect(html).toContain('<a href="https://t/early">2 threads</a>');
  });

  test("a rebase or a thread is orange, CI or requested changes red", () => {
    expect(firstPage([minePr({ mergeState: "dirty" })])).toContain("🟠");
    expect(firstPage([minePr({ ci: { state: "fail", failedJobs: [] } })])).toContain("🔴");
  });

  test("names who a PR waits for", () => {
    expect(firstPage([minePr({ pendingReviewers: ["carol", "backend"] })])).toContain("waiting for carol, backend");
  });

  test("an approved PR that GitHub still blocks, checks or runs CI for", () => {
    expect(firstPage([approved({ mergeState: "blocked", pendingReviewers: ["backend"] })])).toContain("🚧 #");
    expect(firstPage([approved({ mergeState: "blocked", pendingReviewers: ["backend"] })])).toContain(
      "GitHub blocks the merge: waiting for backend"
    );
    expect(firstPage([approved({ mergeState: "unknown" })])).toContain("GitHub is checking the branch");
    expect(firstPage([approved({ ci: { state: "pending", failedJobs: [] } })])).toContain("CI is running");
  });

  test("shows the ticket status, linked", () => {
    const [html] = listOf([minePr({ jira: { key: "PRJ-1", url: "https://j/browse/PRJ-1", status: "In Review" } })]);
    expect(html).toContain('🎫 <a href="https://j/browse/PRJ-1">In Review</a>');
  });

  test("with a Jira merge status, an approved PR waits for the ticket and then is ready", () => {
    const gate = { statuses: ["Merge"] };
    const waiting = approved({ jira: { key: "PRJ-1", url: null, status: "Approved" } });
    expect(firstPage([waiting], { ...options, gate })).toMatch(
      /🟣 #\d+ [^\n]+\nreview passed · waiting for Merge \(now: Approved\)/
    );
    const there = approved({ jira: { key: "PRJ-1", url: null, status: "merge" } });
    expect(firstPage([there], { ...options, gate })).toContain("🟢");
    const unknown = approved({ jira: { key: "PRJ-1", url: null, status: null } });
    expect(firstPage([unknown], { ...options, gate })).toContain("Jira status unavailable");
    expect(firstPage([waiting], options)).toContain("🟢");
  });

  test("escapes titles", () => {
    const [html] = listOf([minePr({ title: "<script> & more" })]);
    expect(html).toContain("&lt;script&gt; &amp; more");
    expect(html).not.toContain("<script>");
  });

  test("says when there is nothing", () => {
    expect(listOf([])).toEqual(["<b>📤 Mine</b> · 10:00\n\n📭 No open PRs of yours."]);
  });
});

describe("the divider", () => {
  test("separates what needs you from what only waits, and counts the second group", () => {
    const text = firstPage([
      minePr({ pendingReviewers: ["carol"] }),
      minePr({ ci: { state: "fail", failedJobs: [] } }),
      minePr(),
    ]);
    expect(text).toContain("Waiting on others · 2");
    expect(text.indexOf("🔴")).toBeLessThan(text.indexOf("Waiting on others"));
    expect(text.indexOf("Waiting on others")).toBeLessThan(text.indexOf("⏳"));
    expect(text.match(/Waiting on others/g)).toHaveLength(1);
  });

  test("is left out when everything needs you or everything waits", () => {
    expect(firstPage([minePr({ ci: { state: "fail", failedJobs: [] } }), approved()])).not.toContain("Waiting on others");
    expect(firstPage([minePr(), minePr()])).not.toContain("Waiting on others");
  });

  test("ready PRs and fixes come before the divider, parked ones (a draft, a waiting ticket) after", () => {
    const text = firstPage([minePr({ isDraft: true }), approved(), minePr({ mergeState: "dirty" })]);
    expect(text.indexOf("🟢")).toBeLessThan(text.indexOf("Waiting on others"));
    expect(text.indexOf("🟠")).toBeLessThan(text.indexOf("Waiting on others"));
    expect(text.indexOf("📝")).toBeGreaterThan(text.indexOf("Waiting on others"));
  });

  test("todo: requests and replies are yours, the rest waits", () => {
    const requested = { ...structuredClone(todo.prs[0]!), number: 1, requestedFromMe: true, threads: [] };
    const waiting = { ...structuredClone(todo.prs[0]!), number: 2, requestedFromMe: false, threads: [] };
    const text = plain(renderList({ ...todo, prs: [waiting, requested] }, options)[0]!);
    expect(text).toContain("Waiting on others · 1");
    expect(text.indexOf("#1 ")).toBeLessThan(text.indexOf("Waiting on others"));
    expect(text.indexOf("#2 ")).toBeGreaterThan(text.indexOf("Waiting on others"));
  });
});

describe("todo rows", () => {
  // prs[0] has no threads of mine; prs[1] has a reply from the author.
  const todoPr = (over: Partial<TodoPr> = {}, from = 0): TodoPr => ({ ...structuredClone(todo.prs[from]!), ...over });
  const render = (prs: TodoPr[]) => plain(renderList({ ...todo, prs }, options)[0]!);

  test("the fixture reads as expected", () => {
    const text = plain(renderList(todo, options)[0]!);
    expect(text).toContain("🔔 #201 PRJ-2001: add audit log\nreview requested · by alice · 0/1 · 2h");
    expect(text).toContain("↩️ #202 PRJ-2002: rework table filters\n1 reply in your threads · by bob · 0/1 · 5d");
  });

  test("a request comes before a reply, and both before waiting", () => {
    const requested = todoPr({ number: 1, requestedFromMe: true, threads: [] });
    const waiting = todoPr({ number: 2, requestedFromMe: false, threads: [] });
    const replied = todoPr({ number: 3, requestedFromMe: false }, 1);
    const text = render([waiting, replied, requested]);
    expect(text.indexOf("#1 ")).toBeLessThan(text.indexOf("#3 "));
    expect(text.indexOf("#3 ")).toBeLessThan(text.indexOf("#2 "));
    expect(text).toContain("👀 #2");
    expect(text).toContain("you reviewed");
  });

  test("a request that also has replies shows both", () => {
    expect(render([todoPr({ requestedFromMe: true }, 1)])).toContain("review requested · 1 reply in your threads");
  });

  test("says when nothing waits for you", () => {
    expect(renderList({ ...todo, prs: [] }, options)).toEqual(["<b>📥 Todo</b> · 10:00\n\n📭 Nothing waits for your review."]);
  });
});

describe("pages and notes", () => {
  test("a long list is cut into pages that each fit in a message", () => {
    const prs = Array.from({ length: 60 }, () =>
      minePr({ title: "A fairly long pull request title that fills the line nicely" })
    );
    const pages = listOf(prs);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(plain(pages[0]!)).toMatch(/^📤 Mine · 60 PRs · 10:00 · 1\/\d+/);
    expect(plain(pages.at(-1)!)).toContain(`· ${pages.length}/${pages.length}`);
    expect(pages.join("").match(/#\d{4}/g)).toHaveLength(60);
  });

  test("an old snapshot says how old it is", () => {
    const later = new Date(NOW.getTime() + 20 * 60_000);
    expect(plain(renderList(mine, { ...options, now: later })[0]!)).toContain("as of 10:00 (20m ago)");
  });

  test("appends a note under the list", () => {
    expect(renderList(mine, { ...options, note: "⚠️ Could not refresh: boom" })[0]).toMatch(/\n\n⚠️ Could not refresh: boom$/);
  });
});
