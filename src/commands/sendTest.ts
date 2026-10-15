import { formatEvents, type OutMessage } from "../format/format.js";
import type { Sink } from "../runner/types.js";
import { SAMPLE_MESSAGES } from "./sampleEvents.js";

export function buildTestMessages(): OutMessage[] {
  return SAMPLE_MESSAGES.flatMap(({ events }, i) =>
    formatEvents(events).map((message) => ({
      ...message,
      text: `🧪 <i>Test ${i + 1}/${SAMPLE_MESSAGES.length}</i>\n${message.text}`,
    }))
  );
}

export async function runSendTest(sink: Sink, out: (line: string) => void): Promise<number> {
  const messages = buildTestMessages();
  out(`Sending ${messages.length} sample notifications…`);
  await sink.deliver(messages);
  out("Done. Check Telegram: each sample shows one kind of notification, the quiet ones arrive without a sound.");
  return messages.length;
}
