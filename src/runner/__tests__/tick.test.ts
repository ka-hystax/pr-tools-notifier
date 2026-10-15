import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSnapshot, type MineSnapshot, type TodoSnapshot } from "../../contract/snapshot.js";
import type { OutMessage } from "../../format/format.js";
import { StateStore } from "../../state/store.js";
import { runTick } from "../tick.js";
import type { Command, Logger, Sink, SnapshotSource } from "../types.js";
import { readFixture as fixture } from "../../__tests__/fixtures.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prn-tick-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const stores = { mine: new StateStore(root, "work", "mine"), todo: new StateStore(root, "work", "todo") };
  const state = { mine: parseSnapshot(fixture("mine")) as MineSnapshot, todo: parseSnapshot(fixture("todo")) as TodoSnapshot };
  const delivered: OutMessage[][] = [];
  const logs: string[] = [];
  const failures: { source: Partial<Record<Command, Error>>; deliver?: Error } = { source: {} };

  const log: Logger = {
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
  };
  const source: SnapshotSource = async (command) => {
    const error = failures.source[command];
    if (error) throw error;
    return structuredClone(state[command]);
  };
  const sink: Sink = {
    async deliver(messages) {
      if (failures.deliver) throw failures.deliver;
      delivered.push(messages);
    },
    async alert() {},
  };
  const tick = (commands: Command[] = ["mine", "todo"], timeZone?: string) =>
    runTick({ commands, source, stores, sink, log, ...(timeZone ? { timeZone } : {}) });
  return { stores, state, delivered, logs, failures, tick };
}

const approve = (s: MineSnapshot, number: number, id: string, author = "carol") => {
  s.prs
    .find((p) => p.number === number)!
    .reviews.push({ id, author, state: "APPROVED", submittedAt: "2026-10-13T11:00:00Z", commitOid: "abc" });
};

const texts = (delivered: OutMessage[][]) => delivered.flat().map((m) => m.text);

describe("runTick", () => {
  test("saves the baselines silently on the first run", async () => {
    const h = setup();
    const result = await h.tick();
    expect(result).toEqual({ ok: true, errors: [], events: 0, messages: 0 });
    expect(h.delivered).toEqual([]);
    expect(h.stores.mine.load().baseline).not.toBeNull();
    expect(h.stores.todo.load().baseline).not.toBeNull();
    expect(h.logs.filter((l) => l.includes("first run"))).toHaveLength(2);
  });

  test("delivers nothing when nothing changed", async () => {
    const h = setup();
    await h.tick();
    const result = await h.tick();
    expect(result).toMatchObject({ ok: true, events: 0, messages: 0 });
    expect(h.delivered).toEqual([]);
  });

  test("delivers new events and then moves the baseline", async () => {
    const h = setup();
    await h.tick();
    approve(h.state.mine, 101, "PRR_NEW");

    const result = await h.tick();
    expect(result).toMatchObject({ ok: true, events: 1, messages: 1 });
    expect(texts(h.delivered)[0]).toContain("approved");
    expect(
      h.stores.mine
        .load()
        .baseline!.snapshot.prs.find((p) => p.number === 101)!
        .reviews.map((r) => r.id)
    ).toContain("PRR_NEW");

    await h.tick();
    expect(h.delivered).toHaveLength(1);
  });

  test("keeps the baseline and repeats the events when delivery fails", async () => {
    const h = setup();
    await h.tick();
    approve(h.state.mine, 101, "PRR_NEW");

    h.failures.deliver = new Error("telegram: 502");
    const failed = await h.tick();
    expect(failed.ok).toBe(false);
    expect(failed.errors).toEqual(["delivery: telegram: 502"]);
    expect(
      h.stores.mine
        .load()
        .baseline!.snapshot.prs.find((p) => p.number === 101)!
        .reviews.map((r) => r.id)
    ).not.toContain("PRR_NEW");

    delete h.failures.deliver;
    const retried = await h.tick();
    expect(retried).toMatchObject({ ok: true, events: 1 });
    expect(h.delivered).toHaveLength(1);
  });

  test("still delivers one command when the other cannot be fetched", async () => {
    const h = setup();
    await h.tick();
    approve(h.state.mine, 101, "PRR_NEW");
    h.failures.source.todo = new Error("gh exited with 1");

    const result = await h.tick();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["todo: gh exited with 1"]);
    expect(result.events).toBe(1);
    expect(h.delivered).toHaveLength(1);
  });

  test("does not move a baseline whose snapshot was not fetched", async () => {
    const h = setup();
    h.failures.source.todo = new Error("boom");
    await h.tick();
    expect(h.stores.mine.load().baseline).not.toBeNull();
    expect(h.stores.todo.load().baseline).toBeNull();
  });

  test("sends the events of both commands as one series", async () => {
    const h = setup();
    h.state.todo.prs.find((p) => p.number === 201)!.requestedFromMe = false;
    await h.tick();

    approve(h.state.mine, 101, "PRR_NEW");
    h.state.todo.prs.find((p) => p.number === 201)!.requestedFromMe = true;
    const result = await h.tick();

    expect(result).toMatchObject({ ok: true, events: 2 });
    expect(h.delivered).toHaveLength(1);
    const text = texts(h.delivered).join("\n");
    expect(text).toContain("<b>#101</b>");
    expect(text).toContain("<b>#201</b>");
  });

  test("adds the since header when the previous snapshot is old and there are several events", async () => {
    const h = setup();
    h.state.mine.generatedAt = "2026-10-13T07:00:00Z";
    h.state.todo.generatedAt = "2026-10-13T07:00:00Z";
    h.state.todo.prs.find((p) => p.number === 201)!.requestedFromMe = false;
    await h.tick();

    h.state.mine.generatedAt = "2026-10-13T10:30:00Z";
    h.state.todo.generatedAt = "2026-10-13T10:30:00Z";
    approve(h.state.mine, 101, "PRR_NEW");
    h.state.todo.prs.find((p) => p.number === 201)!.requestedFromMe = true;
    await h.tick(["mine", "todo"], "UTC");

    expect(texts(h.delivered)[0]).toContain("🌅 <b>Since 07:00 — 2 events</b>");
  });

  test("starts fresh and says so when the state file is unreadable", async () => {
    const h = setup();
    await h.tick();
    writeFileSync(h.stores.mine.path, "{ nope");
    const result = await h.tick(["mine"]);
    expect(result).toMatchObject({ ok: true, events: 0 });
    expect(h.logs.some((l) => l.startsWith("warn: mine:") && l.includes("not valid JSON"))).toBe(true);
  });

  test("only polls the commands it was given", async () => {
    const h = setup();
    await h.tick(["mine"]);
    expect(h.stores.todo.load().baseline).toBeNull();
  });
});
