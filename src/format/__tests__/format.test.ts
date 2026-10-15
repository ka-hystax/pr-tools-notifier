import { describe, expect, test } from "vitest";
import { parseSnapshot, type MineSnapshot, type Thread } from "../../contract/snapshot.js";
import type { MergeStatus, NotifyEvent, PrRef } from "../../diff/diff.js";
import { escapeHtml, formatEvents, MAX_MESSAGE_LENGTH, type FormatOptions, type OutMessage } from "../format.js";
import { readFixture } from "../../__tests__/fixtures.js";

const snapshot = parseSnapshot(readFixture("mine")) as MineSnapshot;
const pr = snapshot.prs[0]!;
const baseThread = pr.threads![0]!;
const baseReview = pr.reviews[0]!;
const THREAD_URL = "https://github.com/acme/web/pull/101#discussion_r1001";

type ThreadEvent = Extract<NotifyEvent, { thread: Thread }>;

const fmt = (events: NotifyEvent[], options?: FormatOptions): string[] => formatEvents(events, options).map((m) => m.text);

function ref(over: Partial<PrRef> = {}): PrRef {
  return { repo: snapshot.repo, number: pr.number, url: pr.url, title: pr.title, author: pr.author, ...over };
}

function thread(over: Partial<Thread> = {}): Thread {
  return { ...baseThread, ...over };
}

function pending(over: Partial<Thread> = {}, prOver: Partial<PrRef> = {}): ThreadEvent {
  return { kind: "thread_pending", pr: ref(prOver), thread: thread(over) };
}

function bot(over: Partial<Thread> = {}): ThreadEvent {
  return pending({ watched: true, opener: "coderabbitai", lastAuthor: "coderabbitai", ...over });
}

const ready: MergeStatus = { kind: "ready" };

function approved(author = "alice", approval: object = {}, status?: MergeStatus): NotifyEvent {
  const merged = { ...pr.approval, ...approval };
  return {
    kind: "review_approved",
    pr: ref(),
    review: { ...baseReview, author },
    approval: merged,
    status: status ?? (merged.decision === "approved" ? ready : { kind: "unapproved" }),
  };
}

function changes(author = "bob"): NotifyEvent {
  return { kind: "review_changes_requested", pr: ref(), review: { ...baseReview, author }, approval: pr.approval };
}

function requested(): NotifyEvent {
  return { kind: "review_requested", pr: ref({ author: "alice" }) };
}

function answered(over: Partial<Thread> = {}): ThreadEvent {
  return {
    kind: "thread_answered",
    pr: ref(),
    thread: thread({ lastAuthor: "bob", excerpt: "Good catch.", commentCount: 2, ...over }),
  };
}

function ciFailed(failedJobs: string[] = ["build-ui"], prOver: Partial<PrRef> = {}): NotifyEvent {
  return { kind: "ci_failed", pr: ref(prOver), failedJobs };
}

function many(count: number, over: (k: number) => Partial<Thread> = () => ({})): ThreadEvent[] {
  return Array.from({ length: count }, (_, k) =>
    pending({
      id: `T${k}`,
      url: `https://github.com/acme/web/pull/101#discussion_r${k}`,
      lastCommentAt: `2026-10-13T09:${String(k).padStart(2, "0")}:00Z`,
      excerpt: `comment ${k}`,
      ...over(k),
    })
  );
}

function prs(count: number): ThreadEvent[] {
  return Array.from({ length: count }, (_, i) =>
    pending(
      { id: `T${i}`, url: `https://github.com/acme/web/pull/${101 + i}#discussion_r${i}` },
      { number: 101 + i, url: `https://github.com/acme/web/pull/${101 + i}` }
    )
  );
}

function bulk(prCount: number): ThreadEvent[] {
  return Array.from({ length: prCount }, (_, n) =>
    [0, 1, 2].map((k) =>
      pending(
        {
          id: `T${n}-${k}`,
          lastAuthor: `u${k}`,
          url: `https://github.com/acme/web/pull/${n + 1}#discussion_r${n * 10 + k}`,
          excerpt: "e ".repeat(100),
        },
        { number: n + 1, url: `https://github.com/acme/web/pull/${n + 1}` }
      )
    )
  ).flat();
}

function balanced(html: string): boolean {
  const count = (re: RegExp) => (html.match(re) ?? []).length;
  return (
    count(/<a /g) === count(/<\/a>/g) &&
    count(/<b>/g) === count(/<\/b>/g) &&
    count(/<i>/g) === count(/<\/i>/g) &&
    count(/<blockquote>/g) === count(/<\/blockquote>/g)
  );
}

describe("escapeHtml", () => {
  test("escapes the three characters Telegram HTML needs", () => {
    expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });
});

describe("formatEvents", () => {
  test("returns no messages for no events", () => {
    expect(formatEvents([])).toEqual([]);
  });

  test("renders a new thread with a PR header, a link on the action and a quoted excerpt", () => {
    const [message] = fmt([pending()]);
    expect(message).toContain(`<a href="${pr.url}"><b>#101</b></a> PRJ-1001: add export button`);
    expect(message).not.toContain("acme/web#");
    expect(message).toContain(`💬 <b>alice</b> <a href="${THREAD_URL}">opened a thread</a>`);
    expect(message).toContain("<blockquote>Should this be disabled while the request is in flight?</blockquote>");
    expect(message).not.toContain("src/export");
  });

  test("words a pending thread with earlier comments as a reply and shows the comment count", () => {
    expect(fmt([pending({ commentCount: 3 })])[0]).toContain(">replied in a thread</a> · 3 comments");
  });

  test("renders the other event kinds", () => {
    expect(fmt([changes()])[0]).toContain("🔄 <b>bob</b> requested changes");
    expect(fmt([requested()])[0]).toContain("🔔 Review requested · PR by <b>alice</b>");
    expect(fmt([answered()])[0]).toContain(`↩️ <b>bob</b> <a href="${THREAD_URL}">replied</a> in your thread · 2 comments`);
    expect(fmt([answered()])[0]).toContain("<blockquote>Good catch.</blockquote>");
    expect(fmt([approved()])[0]).toContain("✅ <b>alice</b> approved · 1/2");
  });

  test("flags an approval that reaches the threshold with Time to merge, not before", () => {
    const met = fmt([approved("carol", { approvers: ["alice", "carol"], decision: "approved" })])[0];
    expect(met).toContain("✅ <b>carol</b> approved · 2/2\n🎉 <b>Time to merge!</b>");
    expect(fmt([approved()])[0]).not.toContain("Time to merge");
  });

  test("counts stale approvers towards the total and says how many there are", () => {
    expect(fmt([approved("alice", { staleApprovers: ["carol"] })])[0]).toContain("approved · 2/2 (1 stale)");
    expect(fmt([approved()])[0]).not.toContain("stale");
  });

  test("joins several approvals or change requests in one tick into one line", () => {
    const [two] = fmt([approved("alice", { decision: "approved" }), approved("carol", { decision: "approved" })]);
    expect(two).toContain("✅ <b>alice</b>, <b>carol</b> approved");
    expect(two!.match(/Time to merge/g)).toHaveLength(1);
    expect(fmt([changes("bob"), changes("dave")])[0]).toContain("🔄 <b>bob</b>, <b>dave</b> requested changes");
  });

  test("lists at most three names and counts the rest", () => {
    const events = ["a", "b", "c", "d", "e"].map((n) => changes(n));
    expect(fmt(events)[0]).toContain("🔄 <b>a</b>, <b>b</b>, <b>c</b> +2 requested changes");
  });

  test("cuts a long excerpt at a word boundary so it fits about three phone lines", () => {
    const [message] = fmt([pending({ excerpt: Array(40).fill("fixed").join(" ") })]);
    const quoted = message!.match(/<blockquote>(.*)<\/blockquote>/s)![1]!;
    expect(Array.from(quoted).length).toBeLessThanOrEqual(100);
    expect(quoted).toMatch(/fixed…$/);
  });

  test("hard-cuts an excerpt with no spaces and keeps short ones whole", () => {
    expect(fmt([pending({ excerpt: "x".repeat(200) })])[0]).toContain(`<blockquote>${"x".repeat(99)}…</blockquote>`);
    expect(fmt([pending({ excerpt: "Fixed." })])[0]).toContain("<blockquote>Fixed.</blockquote>");
  });

  test("omits the quote when the excerpt is empty", () => {
    expect(fmt([pending({ excerpt: "" })])[0]).not.toContain("blockquote");
  });

  test("groups events of one PR under a single header and orders them by urgency", () => {
    const [message] = fmt([approved(), pending(), changes(), requested(), answered()]);
    expect(message!.match(/<b>#101<\/b>/g)).toHaveLength(1);
    const order = ["🔔", "🔄", "💬", "↩️", "✅"].map((emoji) => message!.indexOf(emoji));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  test("gives each PR its own header", () => {
    const [message] = fmt(prs(2));
    expect(message).toContain("<b>#101</b>");
    expect(message).toContain("<b>#102</b>");
  });

  test("escapes user-controlled text in titles, logins, excerpts and urls", () => {
    const [message] = fmt([
      pending(
        { lastAuthor: "<i>x</i>", excerpt: "if (a < b && c > d)", url: 'https://x.test/?a=1&b="2"' },
        { title: "<script>alert(1)</script> & co" }
      ),
    ]);
    expect(message).not.toContain("<script>");
    expect(message).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(message).toContain("<b>&lt;i&gt;x&lt;/i&gt;</b>");
    expect(message).toContain("if (a &lt; b &amp;&amp; c &gt; d)");
    expect(message).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
    expect(balanced(message!)).toBe(true);
  });

  test("clips long titles", () => {
    const [message] = fmt([pending({}, { title: "x".repeat(200) })]);
    expect(message).toContain(`${"x".repeat(79)}…`);
    expect(message).not.toContain("x".repeat(80));
  });
});

describe("ci failures", () => {
  test("links the failure to the checks tab and names the failed jobs", () => {
    expect(fmt([ciFailed(["build-ui", "e2e (chromium)"])])[0]).toContain(
      `❌ <a href="${pr.url}/checks">CI failed</a> · <code>build-ui</code>, <code>e2e (chromium)</code>`
    );
  });

  test("lists at most three jobs and counts the rest", () => {
    expect(fmt([ciFailed(["a", "b", "c", "d", "e"])])[0]).toContain("<code>a</code>, <code>b</code>, <code>c</code> +2");
  });

  test("escapes and clips job names", () => {
    const [text] = fmt([ciFailed(["<img> & co", "x".repeat(100)])]);
    expect(text).toContain("<code>&lt;img&gt; &amp; co</code>");
    expect(text).toContain(`<code>${"x".repeat(39)}…</code>`);
    expect(text).not.toContain("<img>");
  });

  test("omits the job list when no names are known", () => {
    const [text] = fmt([ciFailed([])]);
    expect(text).toContain(">CI failed</a>");
    expect(text).not.toContain("·");
  });

  test("ranks a CI failure below a review request and above change requests and threads", () => {
    const [text] = fmt([changes(), pending(), ciFailed(), requested()]);
    const order = ["🔔", "❌", "🔄", "💬"].map((emoji) => text!.indexOf(emoji));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  test("leads with the failure, opens the checks tab from the button and is never silent", () => {
    const [message] = formatEvents([ciFailed()]);
    expect(message!.text.startsWith("❌")).toBe(true);
    expect(message!.buttons).toEqual([[{ text: "🔗 Open", url: `${pr.url}/checks` }]]);
    expect(message!.silent).toBe(false);
  });
});

describe("merge verdict", () => {
  const met = { approvers: ["alice", "carol"], decision: "approved" as const };
  const verdict = (status: MergeStatus) => fmt([approved("carol", met, status)])[0]!;
  const threadsUrl = "https://github.com/acme/web/pull/101#discussion_r7";
  const checksUrl = `${pr.url}/checks`;
  const todo = (over: Partial<Extract<MergeStatus, { kind: "todo" }>>): MergeStatus => ({
    kind: "todo",
    pendingThreads: 0,
    firstPendingThreadUrl: null,
    ciFailed: false,
    needsRebase: false,
    ...over,
  });
  const threads = (n: number) => ({ pendingThreads: n, firstPendingThreadUrl: threadsUrl });

  test("says it is time to merge when nothing is left to do", () => {
    expect(verdict(ready)).toContain("\n🎉 <b>Time to merge!</b>");
    expect(verdict(ready)).not.toContain("Before merge");
  });

  test("links the pending threads and counts them", () => {
    const text = verdict(todo(threads(2)));
    expect(text).toContain(`\n🚧 Before merge resolve <a href="${threadsUrl}">2 threads</a>`);
    expect(text).not.toContain("Time to merge");
    expect(verdict(todo(threads(1)))).toContain(">1 thread</a>");
  });

  test("points at the checks tab for a failing CI", () => {
    expect(verdict(todo({ ciFailed: true }))).toContain(`🚧 Before merge fix the <a href="${checksUrl}">failing CI</a>`);
  });

  test("asks for a rebase", () => {
    expect(verdict(todo({ needsRebase: true }))).toContain("🚧 Before merge rebase the branch");
  });

  test("lists several things to do in one line", () => {
    expect(verdict(todo({ ...threads(2), needsRebase: true }))).toContain(
      `🚧 Before merge resolve <a href="${threadsUrl}">2 threads</a> and rebase the branch`
    );
    expect(verdict(todo({ ...threads(2), ciFailed: true, needsRebase: true }))).toContain(
      `🚧 Before merge resolve <a href="${threadsUrl}">2 threads</a>, fix the <a href="${checksUrl}">failing CI</a> and rebase the branch`
    );
  });

  test("waits for a running build instead of claiming it is time to merge", () => {
    const text = verdict({ kind: "waiting_ci" });
    expect(text).toContain("\n⏳ Waiting for CI to finish");
    expect(text).not.toContain("Time to merge");
  });

  test("does not promise a merge while GitHub is still checking the branch", () => {
    const text = verdict({ kind: "checking" });
    expect(text).toContain("\n⏳ GitHub is still checking whether the branch can be merged");
    expect(text).not.toContain("Time to merge");
  });

  test("says why GitHub blocks the merge", () => {
    expect(verdict({ kind: "github_blocked", waitingFor: ["backend"] })).toContain(
      "\n🚧 GitHub blocks the merge: waiting for review from <b>backend</b>"
    );
    expect(verdict({ kind: "github_blocked", waitingFor: [] })).toContain(
      "GitHub blocks the merge: a required review or check is missing"
    );
    expect(verdict({ kind: "github_blocked", waitingFor: ["a", "b", "c", "d", "e"] })).toContain(
      "<b>a</b>, <b>b</b>, <b>c</b> +2"
    );
  });

  test("adds nothing to an approval that is still below the threshold", () => {
    const text = fmt([approved("alice", {})])[0]!;
    expect(text).not.toContain("Before merge");
    expect(text).not.toContain("Time to merge");
    expect(text).not.toContain("Waiting");
  });

  test("stays loud when the approval is what makes the PR mergeable, whatever is left to do", () => {
    expect(formatEvents([approved("carol", met, todo({ needsRebase: true }))])[0]!.silent).toBe(false);
  });

  test("is a single event, so the approval leads the message", () => {
    expect(verdict(todo({ needsRebase: true }))).toMatch(/^✅ <b>carol<\/b> approved · 2\/2\n🚧 Before merge/);
  });
});

describe("merge events", () => {
  const readyEvent: NotifyEvent = { kind: "ready_to_merge", pr: ref() };
  const blocked = (waitingFor: string[]): NotifyEvent => ({ kind: "merge_blocked", pr: ref(), waitingFor });

  test("announces that a PR can now be merged, leading with the verdict", () => {
    const [message] = formatEvents([readyEvent]);
    expect(message!.text.startsWith("🎉 <b>Time to merge!</b>\n<a href=")).toBe(true);
    expect(message!.buttons).toEqual([[{ text: "🔗 Open", url: pr.url }]]);
    expect(message!.silent).toBe(false);
  });

  test("announces a merge that GitHub still blocks, with the reason", () => {
    expect(fmt([blocked(["backend"])])[0]).toContain(
      "🚧 All set, but GitHub blocks the merge: waiting for review from <b>backend</b>"
    );
    expect(fmt([blocked([])])[0]).toContain("a required review or check is missing");
    expect(formatEvents([blocked(["backend"])])[0]!.silent).toBe(false);
  });

  test("ranks them after the other events of the PR", () => {
    const [text] = fmt([blocked([]), approved(), pending(), readyEvent]);
    const order = ["💬", "🎉", "✅", "🚧 All set"].map((marker) => text!.indexOf(marker));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });
});

describe("layout", () => {
  test("leads with the event when a message is about one event", () => {
    const [text] = fmt([answered()]);
    expect(text!.startsWith("↩️ <b>bob</b>")).toBe(true);
    expect(text!.endsWith("PRJ-1001: add export button")).toBe(true);
    expect(text!.indexOf("<blockquote>")).toBeLessThan(text!.indexOf("<b>#101</b>"));
  });

  test("treats a two-line approval as one event", () => {
    const [text] = fmt([approved("carol", { approvers: ["alice", "carol"], decision: "approved" })]);
    expect(text).toMatch(/^✅ <b>carol<\/b> approved · 2\/2\n🎉 <b>Time to merge!<\/b>\n<a href=/);
  });

  test("leads with the PR header when a message holds several events or PRs", () => {
    expect(fmt([approved(), changes()])[0]!.startsWith("<a href=")).toBe(true);
    expect(fmt(prs(2))[0]!.startsWith("<a href=")).toBe(true);
  });
});

describe("collapsing threads", () => {
  test("collapses an author's several threads into one linked count, with no excerpts", () => {
    const [message] = fmt(many(2));
    expect(message).toContain(
      '💬 <b>alice</b> opened <a href="https://github.com/acme/web/pull/101#discussion_r0">2 threads</a>'
    );
    expect(message).not.toContain("blockquote");
  });

  test("links the chronologically first thread whatever order the events arrive in", () => {
    expect(fmt(many(5).reverse())[0]).toContain('<a href="https://github.com/acme/web/pull/101#discussion_r0">5 threads</a>');
  });

  test("keeps a single thread as a full entry next to another author's collapsed ones", () => {
    const events = [
      ...many(3),
      pending({
        id: "B",
        lastAuthor: "bob",
        url: "https://github.com/acme/web/pull/101#discussion_rB",
        excerpt: "One question",
      }),
    ];
    const [message] = fmt(events);
    expect(message).toContain("💬 <b>alice</b> opened");
    expect(message).toContain(">3 threads</a>");
    expect(message).toContain("💬 <b>bob</b>");
    expect(message).toContain("<blockquote>One question</blockquote>");
    expect(message!.match(/<blockquote>/g)).toHaveLength(1);
  });

  test("words the collapsed line by whether the threads are new or replies", () => {
    expect(fmt(many(2, () => ({ commentCount: 3 })))[0]).toContain("replied in <a");
    expect(fmt(many(3, (k) => ({ commentCount: k === 0 ? 1 : 2 })))[0]).toContain("commented in <a");
  });

  test("collapses replies in the reviewer's own threads too", () => {
    const events = many(3).map(
      (e): NotifyEvent => ({ kind: "thread_answered", pr: e.pr, thread: { ...e.thread, lastAuthor: "bob" } })
    );
    expect(fmt(events)[0]).toContain(
      '↩️ <b>bob</b> replied in <a href="https://github.com/acme/web/pull/101#discussion_r0">3 of your threads</a>'
    );
  });

  test("shows a bot's single thread with no excerpt", () => {
    const [message] = fmt([bot({ excerpt: "badge | Script executed: sed -n 1,110p" })]);
    expect(message).toContain("🤖 <b>coderabbitai</b> <a ");
    expect(message).toContain(">opened a thread</a>");
    expect(message).not.toContain("blockquote");
    expect(message).not.toContain("Script executed");
  });

  test("shows a bot's several threads as one count", () => {
    const [message] = fmt(many(5, () => ({ watched: true, opener: "coderabbitai", lastAuthor: "coderabbitai" })));
    expect(message).toContain(
      '🤖 <b>coderabbitai</b> opened <a href="https://github.com/acme/web/pull/101#discussion_r0">5 threads</a>'
    );
    expect(message).not.toContain("blockquote");
  });

  test("turns a fifteen-thread review into a single short line", () => {
    const out = fmt(many(15, () => ({ excerpt: "e".repeat(200) })));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(">15 threads</a>");
    expect(out[0]!.length).toBeLessThan(500);
  });

  test("keeps other event kinds of the same PR as separate lines", () => {
    const [message] = fmt([...many(4), changes()]);
    expect(message!.indexOf("🔄")).toBeGreaterThanOrEqual(0);
    expect(message!.indexOf("🔄")).toBeLessThan(message!.indexOf("💬"));
    expect(message!.match(/<b>#101<\/b>/g)).toHaveLength(1);
    expect(balanced(message!)).toBe(true);
  });
});

describe("buttons", () => {
  const urls = (m: OutMessage | undefined) => m!.buttons.flat().map((b) => b.url);

  test("opens the thread for a single thread event", () => {
    expect(formatEvents([pending()])[0]!.buttons).toEqual([[{ text: "🔗 Open", url: THREAD_URL }]]);
  });

  test("opens the first thread of a collapsed group", () => {
    expect(urls(formatEvents(many(3))[0])).toEqual(["https://github.com/acme/web/pull/101#discussion_r0"]);
  });

  test("opens the PR for a non-thread event or when the message has several lines", () => {
    expect(urls(formatEvents([approved()])[0])).toEqual([pr.url]);
    expect(urls(formatEvents([requested()])[0])).toEqual([pr.url]);
    expect(urls(formatEvents([pending(), changes()])[0])).toEqual([pr.url]);
  });

  test("gives each PR its own button, three to a row", () => {
    const rows = formatEvents(prs(4))[0]!.buttons;
    expect(rows.map((row) => row.map((b) => b.text))).toEqual([["🔗 #101", "🔗 #102", "🔗 #103"], ["🔗 #104"]]);
    expect(rows[0]![0]!.url).toBe("https://github.com/acme/web/pull/101");
  });

  test("drops the buttons when a message covers more than six PRs", () => {
    const [message] = formatEvents(prs(7));
    expect(message!.buttons).toEqual([]);
  });

  test("builds buttons per message when the output is split", () => {
    const out = formatEvents(bulk(80));
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) expect(m.buttons.flat().length).toBeLessThanOrEqual(6);
  });
});

describe("since header", () => {
  const four = [pending(), approved(), changes(), requested()];
  const long: FormatOptions = { previousAt: "2026-10-13T09:05:00Z", now: "2026-10-13T11:30:00Z", timeZone: "UTC" };

  test("adds a header with the time of the last snapshot after a long gap", () => {
    expect(fmt(four, long)[0]!.startsWith("🌅 <b>Since 09:05 — 4 events</b>\n\n<a href=")).toBe(true);
  });

  test("is skipped after a short gap", () => {
    expect(fmt(four, { ...long, now: "2026-10-13T09:25:00Z" })[0]).not.toContain("Since");
  });

  test("is skipped for a single event so the event stays first", () => {
    const [text] = fmt([pending()], long);
    expect(text).not.toContain("Since");
    expect(text!.startsWith("💬")).toBe(true);
  });

  test("names the weekday when the snapshot is from an earlier day", () => {
    const opts = { previousAt: "2026-10-09T17:05:00Z", now: "2026-10-12T08:00:00Z", timeZone: "UTC" };
    expect(fmt(four, opts)[0]).toContain("Since Fri 17:05 — 4 events");
  });

  test("names the date after a week or more", () => {
    const opts = { previousAt: "2026-10-01T17:05:00Z", now: "2026-10-13T08:00:00Z", timeZone: "UTC" };
    expect(fmt(four, opts)[0]).toContain("Since 1 Oct 17:05 — 4 events");
  });

  test("is skipped when a timestamp cannot be parsed", () => {
    expect(fmt(four, { ...long, previousAt: "nope" })[0]).not.toContain("Since");
  });

  test("is added to the first message only and still respects the length limit", () => {
    const out = fmt(bulk(80), long);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]!.startsWith("🌅")).toBe(true);
    expect(out.slice(1).some((m) => m.includes("Since"))).toBe(false);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });
});

describe("silent delivery", () => {
  const silent = (events: NotifyEvent[]) => formatEvents(events)[0]!.silent;

  test("is silent for bot threads", () => {
    expect(silent([bot()])).toBe(true);
    expect(silent(many(4, () => ({ watched: true, lastAuthor: "coderabbitai" })))).toBe(true);
  });

  test("is silent for an approval below the threshold and loud at it", () => {
    expect(silent([approved()])).toBe(true);
    expect(silent([approved("carol", { approvers: ["alice", "carol"], decision: "approved" })])).toBe(false);
  });

  test("is loud for people's threads, replies, change requests and review requests", () => {
    for (const event of [pending(), answered(), changes(), requested()]) expect(silent([event])).toBe(false);
  });

  test("is loud when any event in the message is loud", () => {
    expect(silent([bot(), pending({ id: "H", lastAuthor: "bob" })])).toBe(false);
    expect(silent([bot({ id: "B2" }), approved()])).toBe(true);
  });
});

describe("splitting", () => {
  test("splits many PRs into messages under the limit, numbered and tag-balanced, losing nothing", () => {
    const events = bulk(80);
    const out = fmt(events);
    expect(out.length).toBeGreaterThan(1);
    out.forEach((m, i) => {
      expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(m.endsWith(`<i>${i + 1}/${out.length}</i>`)).toBe(true);
      expect(balanced(m)).toBe(true);
    });
    expect(new Set(out.join("\n").match(/discussion_r\d+/g)).size).toBe(events.length);
  });

  test("repeats the PR header when one PR's lines span several messages", () => {
    const out = fmt(many(60, (k) => ({ lastAuthor: `reviewer${k}`, excerpt: "word ".repeat(30) })));
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) {
      expect(m).toContain("<b>#101</b>");
      expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(balanced(m)).toBe(true);
    }
    expect(new Set(out.join("\n").match(/discussion_r\d+/g)).size).toBe(60);
  });

  test("sends a single message without a counter when everything fits", () => {
    const out = fmt([pending(), approved()]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/<i>\d+\/\d+<\/i>/);
  });
});
