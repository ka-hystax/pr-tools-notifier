import { describe, expect, test } from "vitest";
import type { OutMessage } from "../../format/format.js";
import { DryRunSink } from "../dryRun.js";

describe("DryRunSink", () => {
  const message = (over: Partial<OutMessage> = {}): OutMessage => ({
    text: "<b>#1</b> title\n✅ <b>alice</b> approved · 1/2",
    buttons: [[{ text: "🔗 Open", url: "https://github.com/acme/web/pull/1" }]],
    silent: false,
    ...over,
  });

  function capture() {
    const lines: string[] = [];
    return { lines, sink: new DryRunSink((line) => lines.push(line)) };
  }

  test("prints each message as readable text with its buttons", async () => {
    const { lines, sink } = capture();
    await sink.deliver([message()]);
    expect(lines).toEqual([
      "──── message 1/1 ────",
      "#1 title\n✅ alice approved · 1/2",
      "[🔗 Open → https://github.com/acme/web/pull/1]",
      "",
    ]);
  });

  test("marks silent messages and numbers a series", async () => {
    const { lines, sink } = capture();
    await sink.deliver([message({ silent: true }), message({ buttons: [] })]);
    expect(lines[0]).toBe("──── message 1/2 · 🔕 silent ────");
    expect(lines.filter((l) => l.startsWith("────"))).toHaveLength(2);
    expect(lines.some((l) => l.startsWith("[🔗"))).toBe(true);
  });

  test("prints alerts", async () => {
    const { lines, sink } = capture();
    await sink.alert("⚠️ <b>Notifications are failing</b>");
    expect(lines).toEqual(["──── ALERT ────", "⚠️ Notifications are failing", ""]);
  });
});
