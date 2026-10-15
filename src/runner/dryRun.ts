import type { OutMessage } from "../format/format.js";
import { htmlToText } from "../format/text.js";
import type { Sink } from "./types.js";

// Prints what would have been sent.
export class DryRunSink implements Sink {
  constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

  async deliver(messages: OutMessage[]): Promise<void> {
    messages.forEach((message, i) => {
      this.write(`──── message ${i + 1}/${messages.length}${message.silent ? " · 🔕 silent" : ""} ────`);
      this.write(htmlToText(message.text));
      const buttons = message.buttons.map((row) => row.map((b) => `[${b.text} → ${b.url}]`).join(" "));
      if (buttons.length > 0) this.write(buttons.join("\n"));
      this.write("");
    });
  }

  async alert(html: string): Promise<void> {
    this.write("──── ALERT ────");
    this.write(htmlToText(html));
    this.write("");
  }
}
