import { escapeHtml } from "../format/format.js";

export interface Explained {
  summary: string;
  hint: string;
}

const STATUS_PAGE = '<a href="https://www.githubstatus.com">githubstatus.com</a>';

const NETWORK =
  /error connecting to|check your internet connection|connection (reset|refused|closed)|no such host|dial tcp|i\/o timeout|network is unreachable|tls handshake|unexpected eof|read tcp/i;

// First match wins, so the specific causes come before the general ones.
const RULES: [RegExp, (match: RegExpExecArray) => Explained][] = [
  [
    /^delivery: .*\b(401|404)\b/,
    () => ({
      summary: "Telegram rejected the bot token.",
      hint: "Run <code>pr-tools-notifier init</code> to connect a bot again.",
    }),
  ],
  [
    /^delivery: .*\b403\b/,
    () => ({ summary: "Telegram says the bot cannot message you.", hint: "Unblock the bot and press Start in its chat." }),
  ],
  [/^delivery: .*\b429\b/, () => ({ summary: "Telegram is rate-limiting the bot.", hint: "It retries by itself." })],
  [
    /^delivery: /,
    () => ({
      summary: "Could not send messages to Telegram.",
      hint: "Check your internet connection. The events are kept and sent once it works.",
    }),
  ],
  [
    /unknown option '--json'/i,
    () => ({
      summary: "This gh-pr-tools is too old: it does not know <code>--json</code>.",
      hint: "Update it with <code>gh extension upgrade pr-tools</code>.",
    }),
  ],
  [
    /does not report Jira tickets/i,
    () => ({
      summary: "This gh-pr-tools is too old: it does not report Jira tickets.",
      hint: "Update it with <code>gh extension upgrade pr-tools</code>.",
    }),
  ],
  [
    /track does not take Jira tickets/i,
    () => ({
      summary: "This gh-pr-tools is too old: <code>track</code> does not take Jira tickets.",
      hint: "Update it with <code>gh extension upgrade pr-tools</code>, or track PR numbers instead.",
    }),
  ],
  [
    /unknown profile '([^']+)'/i,
    (m) => ({
      summary: `The gh-pr-tools profile <b>${escapeHtml(m[1]!)}</b> does not exist.`,
      hint: "Check <code>gh pr-tools profile list</code>, or recreate it with <code>gh pr-tools init</code>.",
    }),
  ],
  [
    /was not found in PATH/i,
    () => ({
      summary: "The <code>gh</code> command was not found.",
      hint: "Install gh or fix PATH in the terminal where the notifier runs.",
    }),
  ],
  [
    /gh auth login|authenticat|bad credentials|HTTP 401/i,
    () => ({
      summary: "GitHub did not accept the <code>gh</code> login.",
      hint: "Run <code>gh auth status</code>, then <code>gh auth login</code> if needed.",
    }),
  ],
  [
    /rate limit/i,
    () => ({
      summary: "GitHub API rate limit reached.",
      hint: "Polling resumes after the limit resets; a longer <code>--interval</code> lowers the usage.",
    }),
  ],
  [
    /HTTP (5\d\d)/i,
    (m) => ({ summary: `GitHub returned an error (HTTP ${m[1]}).`, hint: `Usually temporary, see ${STATUS_PAGE}.` }),
  ],
  [
    /timed out after (\d+)s/i,
    (m) => ({
      summary: `GitHub did not answer within ${m[1]} s.`,
      hint: "Usually a dropped network or a laptop that just woke up. Polling continues.",
    }),
  ],
  [NETWORK, () => ({ summary: "Cannot reach GitHub.", hint: `Check your internet connection or ${STATUS_PAGE}.` })],
  [
    /output is not valid JSON/i,
    () => ({
      summary: "gh-pr-tools returned data the notifier cannot read.",
      hint: "Update it with <code>gh extension upgrade pr-tools</code>.",
    }),
  ],
];

// A readable reason for the failures people run into; null for anything else.
export function explainFailure(error: string): Explained | null {
  for (const [pattern, explain] of RULES) {
    const match = pattern.exec(error);
    if (match) return explain(match);
  }
  return null;
}
