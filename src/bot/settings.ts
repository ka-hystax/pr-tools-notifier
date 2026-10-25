import { DEFAULT_INTERVAL_MS, formatInterval, INTERVAL_PRESETS } from "../config/interval.js";
import type { Settings } from "../config/settings.js";
import { bold, escapeHtml } from "../format/format.js";
import type { ApiButton } from "../telegram/api.js";

export const CLOSE: ApiButton = { text: "✖ Close", data: "x" };
const BACK: ApiButton = { text: "‹ Back", data: "s" };
const PER_ROW = 4;

export interface SettingsView {
  settings: Settings;
  // `run --interval` wins over the setting for this run.
  intervalFlagMs?: number;
  editable: boolean;
  note?: string;
}

// "5m", "1m (default)", or the --interval value with the saved one beside it.
function intervalValue({ settings, intervalFlagMs }: SettingsView): string {
  const saved =
    settings.intervalMs === undefined
      ? `${formatInterval(DEFAULT_INTERVAL_MS)} (default)`
      : formatInterval(settings.intervalMs);
  if (intervalFlagMs === undefined) return bold(saved);
  return `${bold(formatInterval(intervalFlagMs))} from <code>--interval</code> for this run (the setting is ${saved})`;
}

function statusLine({ settings }: SettingsView): string {
  return settings.mergeStatuses
    ? `🎫 Jira merge status: ${bold(settings.mergeStatuses.join(", "))}`
    : "🎫 Jira merge status: not set, “Time to merge” comes as soon as a PR is ready";
}

export function settingsScreen(view: SettingsView): { text: string; buttons: ApiButton[][] } {
  const lines = [`⚙️ ${bold("Settings")}`, `⏱ Poll interval: ${intervalValue(view)}`, statusLine(view), ""];
  lines.push(
    view.editable
      ? "<i>Changes apply within a minute, no restart needed.</i>"
      : "<i>Change them with <code>pr-tools-notifier config</code>.</i>"
  );
  if (view.note) lines.push("", view.note);
  const edit: ApiButton[] = [
    { text: "⏱ Interval", data: "si" },
    { text: "🎫 Jira status", data: "sj" },
  ];
  return { text: lines.join("\n"), buttons: view.editable ? [edit, [CLOSE]] : [[CLOSE]] };
}

export function intervalScreen(view: SettingsView): { text: string; buttons: ApiButton[][] } {
  const current = view.settings.intervalMs === undefined ? null : formatInterval(view.settings.intervalMs);
  const presets: ApiButton[] = INTERVAL_PRESETS.map((p) => ({ text: p === current ? `✓ ${p}` : p, data: `si:${p}` }));
  presets.push({ text: current === null ? "✓ Default" : "Default", data: "si:-" });
  const rows: ApiButton[][] = [];
  for (let i = 0; i < presets.length; i += PER_ROW) rows.push(presets.slice(i, i + PER_ROW));
  rows.push([BACK]);
  const text = [
    `⏱ ${bold("Poll interval")}`,
    "How often to ask GitHub what changed. Shorter is fresher; longer spends fewer API points (every minute is about 7% of the hourly limit).",
    "",
    `Now: ${intervalValue(view)}`,
  ].join("\n");
  return { text, buttons: rows };
}

export function statusPrompt(view: SettingsView): { text: string; buttons: ApiButton[][] } {
  const now = view.settings.mergeStatuses ? `Now: ${bold(view.settings.mergeStatuses.join(", "))}.` : "Not set now.";
  const text = [
    `🎫 ${bold("Jira merge status")}`,
    "Which Jira status means “time to merge”? Send its name as a message, for example <code>Merge</code>; separate several with commas.",
    now,
    "",
    "<i>The ticket comes from the branch name and is read through your gh-pr-tools profile, which needs a Jira site, email and API token.</i>",
  ].join("\n");
  const row: ApiButton[] = view.settings.mergeStatuses ? [{ text: "🗑 Clear", data: "sj:-" }, BACK] : [BACK];
  return { text, buttons: [row] };
}

export function savedNote(what: string): string {
  return `✅ ${escapeHtml(what)}`;
}
