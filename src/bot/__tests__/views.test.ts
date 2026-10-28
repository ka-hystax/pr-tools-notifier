import { describe, expect, test } from "vitest";
import { parseSnapshot, type MineSnapshot, type Review, type Thread, type TodoSnapshot } from "../../contract/snapshot.js";
import { readFixture } from "../../__tests__/fixtures.js";
import { MAX_MESSAGE_LENGTH } from "../../format/format.js";
import { ago, renderList, renderLists } from "../views.js";

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

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "T",
  state: "pending",
  opener: "alice",
  lastAuthor: "alice",
  watched: false,
  commentCount: 1,
  path: null,
  url: "https://t/1",
  lastCommentAt: "2026-10-13T09:00:00Z",
  excerpt: "",
  ...over,
});

// The rows of a block, as plain text, in order.
function block(text: string, title: string): string[] {
  const start = text.indexOf(`${title} · `);
  if (start < 0) return [];
  const rest = text
    .slice(start)
    .split("\n\n")
    .slice(1)
    .map((part) => part.replace(/^\n/, ""));
  const end = rest.findIndex((part) => /^(✅ Approved|👀 In review|🔔 Your turn|⏳ Waiting for authors) · \d+/.test(part));
  return end < 0 ? rest : rest.slice(0, end);
}

describe("mine: the two blocks", () => {
  test("the fixture is all in review: changes, threads and a broken build first, a draft last", () => {
    const text = plain(renderList(mine, options)[0]!);
    expect(text).toMatch(
      /^📤 Mine · 3 PRs · 10:00\n\n✅ Approved · 0\n\nNo PR has enough approvals yet\.\n\n\n👀 In review · 3\n\n/
    );
    expect(block(text, "👀 In review")).toEqual([
      "#101 PRJ-1001: add export button\n🔄 changes requested by bob · 💬 2 open threads · ❌ CI failed · 🔀 conflicts · ⏳ review from backend · 1/2 · 4d",
      "#102 PRJ-1002: fix locale fallback\n⏳ needs approvals · 0/2 · 3d",
      "#103 PRJ-1003: migrate settings page\n📝 draft · 1/2 (1 stale) · 2d",
    ]);
  });

  test("two empty lines separate the blocks, one separates the rows", () => {
    const [html] = listOf([approved(), approved(), minePr()]);
    expect(html).toMatch(/2\/2 · \d+d\n\n\n<b>👀 In review · 1<\/b>\n\n<a /);
    expect(html).toMatch(/<b>✅ Approved · 2<\/b>\n\n<a [^\n]+\n[^\n]+\n\n<a /);
  });

  test("the block headers are bold and count their rows", () => {
    const [html] = listOf([approved(), minePr()]);
    expect(html).toContain("<b>✅ Approved · 1</b>");
    expect(html).toContain("<b>👀 In review · 1</b>");
    expect(html!.indexOf("✅ Approved")).toBeLessThan(html!.indexOf("👀 In review"));
  });

  test("enough approvals and nothing in the way: ready to merge", () => {
    expect(block(firstPage([approved()]), "✅ Approved")).toEqual([
      expect.stringMatching(/\n🟢 ready to merge · 2\/2 · \d+d$/),
    ]);
  });

  test("approved with a failed build, conflicts or a stale branch stays under Approved: one fix away", () => {
    const text = firstPage([
      approved({ ci: { state: "fail", failedJobs: ["build"] } }),
      approved({ mergeState: "dirty" }),
      approved({ mergeState: "behind" }),
    ]);
    expect(block(text, "✅ Approved").map((r) => r.split("\n")[1]!.split(" · ")[0])).toEqual([
      "❌ CI failed",
      "🔀 conflicts",
      "🔀 needs a rebase",
    ]);
    expect(text).not.toContain("In review");
  });

  test("an empty Approved block still shows, saying so; an empty In review block is left out", () => {
    const [html] = listOf([minePr()]);
    expect(html).toContain("<b>✅ Approved · 0</b>\n\n<i>No PR has enough approvals yet.</i>\n\n\n<b>👀 In review · 1</b>");
  });

  test("approved but with open threads goes to In review", () => {
    const text = firstPage([approved({ threads: [thread()] })]);
    expect(block(text, "👀 In review")).toEqual([expect.stringContaining("💬 1 open thread · 2/2")]);
  });

  test("approved but GitHub waits for a code owner goes to In review", () => {
    const text = firstPage([
      approved({ mergeState: "blocked", pendingReviewers: ["backend"] }),
      approved({ mergeState: "blocked" }),
    ]);
    expect(block(text, "👀 In review")).toEqual([
      expect.stringContaining("🚧 review from backend · 2/2"),
      expect.stringContaining("🚧 GitHub blocks the merge · 2/2"),
    ]);
  });

  test("requested changes keep a PR in review even with enough approvals", () => {
    const pr = approved({
      approval: { ...base.approval, approvers: ["a", "b"], changesRequestedBy: ["bob"], decision: "approved" },
    });
    expect(block(firstPage([pr]), "👀 In review")).toEqual([expect.stringContaining("🔄 changes requested by bob")]);
  });

  test("Approved: ready first, then fixes, then CI or GitHub, then the Jira ticket", () => {
    const gate = { statuses: ["Merge"] };
    const text = firstPage(
      [
        approved({ jira: { key: "PRJ-1", url: null, status: "Approved" } }),
        approved({ ci: { state: "pending", failedJobs: [] } }),
        approved({ mergeState: "dirty" }),
        approved(),
        approved({ mergeState: "unknown" }),
      ],
      { ...options, gate }
    );
    expect(block(text, "✅ Approved").map((r) => r.split("\n")[1]!.split(" · ")[0])).toEqual([
      "🟢 ready to merge",
      "🔀 conflicts",
      "⏳ CI running",
      "⏳ GitHub is checking the branch",
      "🎫 waiting for the merge status (Approved)",
    ]);
  });

  test("In review: changes, then threads or a broken build, then reviewers, drafts last", () => {
    const text = firstPage([
      minePr({ isDraft: true }),
      minePr({ pendingReviewers: ["carol"] }),
      minePr({ threads: [thread()] }),
      minePr({ approval: { ...base.approval, changesRequestedBy: ["bob"] } }),
    ]);
    expect(block(text, "👀 In review").map((r) => r.split("\n")[1]!.split(" · ")[0])).toEqual([
      "🔄 changes requested by bob",
      "💬 1 open thread",
      "⏳ review from carol",
      "📝 draft",
    ]);
  });

  test("links the checks and the oldest open thread", () => {
    const [html] = listOf([
      minePr({
        ci: { state: "fail", failedJobs: ["build"] },
        threads: [
          thread({ id: "A", url: "https://t/late", lastCommentAt: "2026-10-13T10:00:00Z" }),
          thread({ id: "B", url: "https://t/early" }),
        ],
      }),
    ]);
    expect(html).toMatch(/❌ <a href="[^"]+\/checks">CI failed<\/a>/);
    expect(html).toContain('💬 <a href="https://t/early">2 open threads</a>');
  });

  test("a waiting Jira ticket names its status once, linked", () => {
    const gate = { statuses: ["Merge", "Слияние"] };
    const [html] = listOf([approved({ jira: { key: "PRJ-1", url: "https://j/browse/PRJ-1", status: "Подтверждено" } })], {
      ...options,
      gate,
    });
    expect(html).toContain('🎫 waiting for the merge status (<a href="https://j/browse/PRJ-1">Подтверждено</a>) · 2/2 ·');
    expect(html!.match(/Подтверждено/g)).toHaveLength(1);
    const unknown = firstPage([approved({ jira: { key: "PRJ-1", url: null, status: null } })], { ...options, gate });
    expect(unknown).toContain("🎫 waiting for the merge status (Jira status unavailable)");
    expect(unknown).not.toContain("Слияние");
  });

  test("a ticket already in the merge status is ready, with its status as a chip", () => {
    const gate = { statuses: ["Merge"] };
    const text = firstPage([approved({ jira: { key: "PRJ-1", url: null, status: "merge" } })], { ...options, gate });
    expect(text).toContain("🟢 ready to merge · 2/2 · 🎫 merge · ");
  });

  test("without a gate the ticket is only a chip, in either block", () => {
    const jira = { key: "PRJ-1", url: "https://j/browse/PRJ-1", status: "In Review" };
    const [html] = listOf([approved({ jira }), minePr({ jira })]);
    expect(html!.match(/🎫 <a href="https:\/\/j\/browse\/PRJ-1">In Review<\/a>/g)).toHaveLength(2);
    expect(html).toContain("🟢 ready to merge");
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

describe("todo: the two blocks", () => {
  // prs[0] is a plain review request; prs[1] has a reply from the author in the viewer's thread.
  const todoPr = (over: Partial<TodoPr> = {}, from = 0): TodoPr => ({ ...structuredClone(todo.prs[from]!), ...over });
  const render = (prs: TodoPr[]) => plain(renderList({ ...todo, prs }, options)[0]!);
  const review = (
    state: Review["state"],
    at: string,
    commitOid: string | null = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ): Review => ({
    id: `R${at}`,
    author: "dev-me",
    state,
    submittedAt: `2026-10-13T0${at}:00:00Z`,
    commitOid,
  });
  const waitingLine = (over: Partial<TodoPr>) =>
    block(render([todoPr({ requestedFromMe: false, ...over })]), "⏳ Waiting for authors")[0]!.split("\n")[1]!;

  test("the fixture: a request first, then a reply, both your turn", () => {
    const text = render(todo.prs);
    expect(text).toMatch(/^📥 Todo · 2 PRs · 10:00\n\n🔔 Your turn · 2\n\n/);
    expect(block(text, "🔔 Your turn")).toEqual([
      "#201 PRJ-2001: add audit log\n🔔 review requested · by alice · 0/1 · 2h",
      "#202 PRJ-2002: rework table filters\n↩️ 1 reply in your threads · by bob · 0/1 · 5d",
    ]);
  });

  test("an empty Your turn block says that nothing needs you", () => {
    const text = render([todoPr({ requestedFromMe: false })]);
    expect(text).toMatch(
      /^📥 Todo · 1 PR · 10:00\n\n🔔 Your turn · 0\n\nNothing needs you right now\.\n\n\n⏳ Waiting for authors · 1\n\n/
    );
  });

  test("what waits for the author is listed under its own header", () => {
    const text = render([todoPr({ number: 1, requestedFromMe: true }), todoPr({ number: 2, requestedFromMe: false })]);
    expect(text).toContain("🔔 Your turn · 1");
    expect(text).toContain("⏳ Waiting for authors · 1");
    expect(text.indexOf("#1 ")).toBeLessThan(text.indexOf("⏳ Waiting for authors"));
  });

  test("shows your own verdict and whether commits came after it", () => {
    expect(waitingLine({ reviews: [review("APPROVED", "9")] })).toMatch(/^✅ you approved · by alice/);
    expect(waitingLine({ reviews: [review("APPROVED", "9", "old")] })).toMatch(/^✅ you approved, new commits since · /);
    expect(waitingLine({ reviews: [review("CHANGES_REQUESTED", "9")] })).toMatch(/^🔄 you requested changes · /);
    expect(waitingLine({ reviews: [review("COMMENTED", "9")] })).toMatch(/^💬 you commented · /);
  });

  test("a comment after an approval does not take the approval back; a later change request does", () => {
    expect(waitingLine({ reviews: [review("APPROVED", "8"), review("COMMENTED", "9")] })).toMatch(/^✅ you approved/);
    expect(waitingLine({ reviews: [review("APPROVED", "8"), review("CHANGES_REQUESTED", "9")] })).toMatch(
      /^🔄 you requested changes/
    );
  });

  test("open threads of yours come first, and replace a bare 'you commented'", () => {
    const threads = [thread({ opener: "dev-me", lastAuthor: "dev-me", url: "https://t/mine" })];
    expect(waitingLine({ threads, reviews: [review("COMMENTED", "9")] })).toMatch(/^💬 1 of your threads open · by alice/);
    expect(waitingLine({ threads, reviews: [review("APPROVED", "9")] })).toMatch(
      /^💬 1 of your threads open · ✅ you approved · /
    );
  });

  test("a reviewer with nothing submitted yet", () => {
    expect(waitingLine({ reviews: [] })).toMatch(/^👀 you are a reviewer · by alice/);
  });

  test("says when nothing waits for you", () => {
    expect(renderList({ ...todo, prs: [] }, options)).toEqual(["<b>📥 Todo</b> · 10:00\n\n📭 Nothing waits for your review."]);
  });
});

describe("several profiles", () => {
  test("give each profile a section under one header that counts every PR", () => {
    const [page] = renderLists(
      [
        { profile: "web", snapshot: { ...mine, prs: [approved({ title: "Add CSV export" })] } },
        { profile: "api", snapshot: { ...mine, prs: [] } },
      ],
      options
    );
    expect(plain(page!).split("\n\n")).toEqual([
      "📤 Mine · 1 PR · 10:00",
      "🗂 web",
      "✅ Approved · 1",
      expect.stringMatching(/^#\d+ Add CSV export\n🟢 ready to merge/),
      "\n🗂 api",
      "No open PRs of yours.",
    ]);
  });

  test("dates the list by the oldest snapshot", () => {
    const older = { ...todo, generatedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() };
    const [page] = renderLists(
      [
        { profile: "web", snapshot: todo },
        { profile: "api", snapshot: older },
      ],
      options
    );
    expect(plain(page!)).toMatch(/^📥 Todo · 4 PRs · as of 09:40 \(20m ago\)/);
  });

  test("say so once when nothing is anywhere", () => {
    const empty = { ...mine, prs: [] };
    expect(
      renderLists(
        [
          { profile: "web", snapshot: empty },
          { profile: "api", snapshot: empty },
        ],
        options
      )
    ).toEqual(["<b>📤 Mine</b> · 10:00\n\n📭 No open PRs of yours."]);
  });
});

describe("pages and notes", () => {
  test("a long list is cut into pages that each fit in a message, and a block that goes on says so", () => {
    const prs = Array.from({ length: 60 }, () =>
      minePr({ title: "A fairly long pull request title that fills the line nicely" })
    );
    const pages = listOf(prs);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(plain(pages[0]!)).toMatch(
      /^📤 Mine · 60 PRs · 10:00 · 1\/\d+\n\n✅ Approved · 0\n\nNo PR has enough approvals yet\.\n\n\n👀 In review · 60\n\n/
    );
    expect(plain(pages[1]!)).toMatch(/\n\n👀 In review · 60 \(continued\)\n\n#/);
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
