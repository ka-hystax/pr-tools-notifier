import { describe, expect, test } from "vitest";
import type { OutMessage } from "../../format/format.js";
import { SAMPLE_MESSAGES } from "../sampleEvents.js";
import { buildTestMessages, runSendTest } from "../sendTest.js";
import type { Sink } from "../../runner/types.js";

describe("buildTestMessages", () => {
  const messages = buildTestMessages();

  test("has a message for every sample, each labelled as a test", () => {
    expect(messages).toHaveLength(SAMPLE_MESSAGES.length);
    messages.forEach((m, i) => expect(m.text.startsWith(`🧪 <i>Test ${i + 1}/${SAMPLE_MESSAGES.length}</i>\n`)).toBe(true));
  });

  test("covers every notification kind", () => {
    const all = messages.map((m) => m.text).join("\n");
    for (const marker of ["💬", "🤖", "↩️", "✅", "🎉", "🚧", "⏳", "🔄", "🔔", "❌"]) expect(all).toContain(marker);
  });

  test("includes both loud and silent messages, each with a button", () => {
    expect(messages.some((m) => m.silent)).toBe(true);
    expect(messages.some((m) => !m.silent)).toBe(true);
    expect(messages.every((m) => m.buttons.length > 0)).toBe(true);
  });

  test("fits Telegram's limit", () => {
    expect(messages.every((m) => m.text.length <= 4096)).toBe(true);
  });
});

describe("runSendTest", () => {
  test("delivers all the samples through the sink and says how many", async () => {
    const delivered: OutMessage[][] = [];
    const sink: Sink = {
      async deliver(m) {
        delivered.push(m);
      },
      async alert() {},
    };
    const lines: string[] = [];
    const count = await runSendTest(sink, (l) => lines.push(l));
    expect(count).toBe(SAMPLE_MESSAGES.length);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toHaveLength(count);
    expect(lines[0]).toContain(`Sending ${count} sample notifications`);
  });
});
