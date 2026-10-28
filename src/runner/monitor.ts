import { escapeHtml } from "../format/format.js";
import { explainFailure } from "./explain.js";
import type { TickResult } from "./types.js";

const ERROR_MAX = 300;

const GENERIC_HINT = "Check <code>gh auth status</code> and the network.";

// One alert per outage: after enough failed ticks in a row, until a tick succeeds again.
export class FailureMonitor {
  private failures = 0;
  private since: Date | null = null;
  private lastError = "";
  private alerted = false;

  // The profile is named in the alert when a run polls several.
  constructor(
    private readonly threshold = 3,
    private readonly profile?: string
  ) {}

  record(result: TickResult, at: Date): void {
    if (result.ok) {
      this.failures = 0;
      this.since = null;
      this.lastError = "";
      this.alerted = false;
      return;
    }
    this.failures += 1;
    this.since ??= at;
    this.lastError = result.errors[0] ?? "unknown error";
  }

  pendingAlert(timeZone?: string): string | null {
    if (this.alerted || this.failures < this.threshold || this.since === null) return null;
    const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      this.since
    );
    const explained = explainFailure(this.lastError);
    const error = this.lastError.length > ERROR_MAX ? `${this.lastError.slice(0, ERROR_MAX - 1)}…` : this.lastError;
    const detail = explained ? `${explained.summary}\n${explained.hint}` : `<code>${escapeHtml(error)}</code>\n${GENERIC_HINT}`;
    const what = this.profile ? ` for <b>${escapeHtml(this.profile)}</b>` : "";
    return `⚠️ <b>Notifications are failing</b>${what} since ${time} (${this.failures} attempts in a row)\n${detail}`;
  }

  markAlerted(): void {
    this.alerted = true;
  }
}
