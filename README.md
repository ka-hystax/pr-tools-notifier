# pr-tools-notifier

Telegram notifications for your pull requests, on top of [gh-pr-tools](https://github.com/ek-hystax/gh-pr-tools).

A small process on your machine polls `gh pr-tools mine` and `todo`, compares each snapshot with the previous one and sends only what changed to your own Telegram bot. You can also ask the bot for your lists (`/todo`, `/mine`). Nothing runs in the cloud and nothing listens for incoming connections: the bot only reads its own messages from Telegram.

```
💬 alice opened a thread
Should this be disabled while the request is in flight?
#101 PRJ-1001. Add export button                      [🔗 Open]

✅ carol approved · 2/2
🚧 Before merge resolve 2 threads, fix the failing CI and rebase the branch
#101 PRJ-1001. Add export button                      [🔗 Open]
```

## What you get

| Command | Notification                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `mine`  | a new thread waiting for you (bot threads are compact and silent), an approval with the merge verdict, changes requested, CI failed    |
| `mine`  | 🎉 ready to merge, or 🚧 GitHub blocks the merge (for example, waiting for a code-owner team) — when it happens without a new approval |
| `todo`  | review requested from you, a reply in a thread you started                                                                             |
| `mine`  | with a Jira merge status (see [Waiting for Jira](#waiting-for-jira)): 🟢 review passed, then 🎉 when the ticket reaches that status    |

The approval verdict uses the approval threshold from your gh-pr-tools profile. Approvals given before a rebase or a small fix (stale) still count; the message then says `Approved 2/2 (2 stale)`, and GitHub's own merge state decides whether the merge is really allowed. Your own actions, threads you answered last and review requests on drafts never notify. Approvals below the threshold and bot threads arrive without a sound.

## Setup

You need Node.js 22.16+, npm (or [pnpm](https://pnpm.io)) and [gh](https://cli.github.com/).

**1. gh-pr-tools and a profile.** The notifier reads `gh pr-tools <command> --json`, so make sure the extension is up to date (see its [README](https://github.com/ek-hystax/gh-pr-tools#readme) for the profile questions):

```bash
gh extension install ek-hystax/gh-pr-tools   # or: gh extension upgrade pr-tools
gh pr-tools init
```

**2. The notifier.**

```bash
git clone https://github.com/ka-hystax/pr-tools-notifier.git
cd pr-tools-notifier
npm install         # also builds dist/
npm link            # puts `pr-tools-notifier` on your PATH
```

With pnpm: `pnpm install` and `pnpm link --global` (run `pnpm setup` once if it complains about PATH). Without linking, use `node dist/cli.js <command>` instead of `pr-tools-notifier <command>`.

To update, run `git pull && npm install` in the clone; the linked command picks up the rebuilt `dist/`.

**3. Your own bot.** Everyone creates their own bot, so there is no shared secret.

```bash
pr-tools-notifier init
```

It asks for a token from [@BotFather](https://t.me/BotFather) (`/newbot`), prints a `t.me/<bot>?start=<code>` link, and picks up your chat id when you press Start. If that does not work, you can paste the chat id by hand. At the end it asks, as an optional step, whether "Time to merge" should wait for a Jira status (see [Waiting for Jira](#waiting-for-jira-optional)); gh-pr-tools is required, Jira is not. Then check the setup:

```bash
pr-tools-notifier send-test
```

You get one sample of every notification kind, with the quiet ones arriving silently.

**4. Run.**

```bash
pr-tools-notifier run
```

With one gh-pr-tools profile that is all; with several, say which: `run -p PROFILE`. Keep it in a terminal tab or tmux. The first poll only records the current state (`first run, saved N PRs as the baseline`), so you are not flooded with old PRs.

### Asking the bot

While `run` is going, the bot also answers you. It has buttons under the input field and a `/` menu:

| Command   | Answer                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------- |
| `/todo`   | PRs waiting for your review: requested, replied to, or just waiting                            |
| `/mine`   | your open PRs, what to do next for each; what needs you first, what only waits below a divider |
| `/status` | the profile, the last poll and the settings                                                    |
| `/help`   | what the bot can do (`/start` shows it too)                                                    |

```
📤 Mine · 3 PRs · 10:00

🟢 #1281 Localization
ready to merge · 2/2 · 3d

🔴 #1216 PRJ-1865. Fix the date picker
changes requested by bob · CI failed · 2 threads · 1/2 · 4d

Waiting on others · 1

⏳ #1289 PRJ-1992. Raise the upload limit
waiting for carol, backend · 0/2 · 1d
                                          [🔄 Refresh] [✖ Close]
```

A list comes from the last poll when that is under two minutes old, otherwise from a fresh request (a few seconds; if GitHub cannot be reached, the last poll is shown with a note). `🔄 Refresh` asks again without touching what the notifications are compared against. Long lists get `Next ▶` and `◀ Prev`.

The bot keeps one answer on screen: asking for something else, or pressing `✖ Close`, takes the previous answer and your own command message down, so the chat holds notifications and the latest view, never old lists. Notifications are not deleted.

Only the chat you connected is heard; messages from anyone else are ignored (the terminal says so once). A command older than two minutes, for example one sent while the laptop slept, is dropped instead of answered late. Only one `run` reads the bot's messages (`state/bot.lock`); another `run` for a different profile still sends its notifications.

### Waiting for Jira (optional)

If your team merges only after the ticket is moved to a status (a `Merge` column, say), tell the notifier which one:

```bash
pr-tools-notifier config set merge-status Merge
```

An approval that clears every blocker then says `🟢 Review passed · waiting for PRJ-1826 to reach Merge (now: In Review)` instead of 🎉. When the ticket reaches the status, the 🎉 `Time to merge!` follows. If something still blocks the PR at that moment, the message lists it instead (`📌 PRJ-1826 moved to Merge`, `🚧 Before merge resolve 2 threads…`), and once the blockers are gone a second 🎉 says `PRJ-1826 is in Merge · no blockers left`. Several statuses can be given, separated by commas; names are compared without regard to case. See [Settings](#settings).

The ticket comes from gh-pr-tools, which already knows how to read Jira, so the notifier needs no credentials of its own. It takes the ticket key from the branch name (`bug/PRJ-1865`) and reads its status with the Jira token of your profile. Without one, add it once:

```bash
gh pr-tools -p PROFILE profile set jira-site yourorg
gh pr-tools -p PROFILE profile set jira-email you@example.com
gh pr-tools -p PROFILE profile set jira-api-token      # prompts, hidden
```

See the [Jira token](https://github.com/ek-hystax/gh-pr-tools#jira-token) section of gh-pr-tools for how to create the token. PRs whose branch has no ticket key are announced as before. Without the token, the terminal warns `no Jira status came back` and the messages say `Jira status unavailable`, since the notifier cannot know whether the ticket is ready. Restart `run` after changing a setting.

### Settings

Two optional settings live in `~/.config/pr-tools-notifier/settings.env`, one `KEY=value` per line (`#` starts a comment). Edit the file by hand or use the command:

```
pr-tools-notifier config                       show the settings and where the file is
pr-tools-notifier config set KEY VALUE         change one (quote a value with spaces)
pr-tools-notifier config unset KEY             remove one
```

| Key             | Value                                                                   | Default |
| --------------- | ----------------------------------------------------------------------- | ------- |
| `MERGE_STATUS`  | Jira statuses that mean "time to merge", comma-separated: `Merge,Ready` | none    |
| `POLL_INTERVAL` | time between polls: `90s`, `5m`, `1h`; from `1m` to `12h`               | `1m`    |

`config set` accepts the key in any case and with `-` for `_` (`merge-status`). A typo in the file stops `run` with the file and line, instead of being silently ignored. The `--interval` option of `run` overrides `POLL_INTERVAL` for one run.

## Commands

```
pr-tools-notifier init                  set up your bot (once)
pr-tools-notifier --version             print the version
pr-tools-notifier status                show the bot, its check against Telegram and the saved state
pr-tools-notifier config [set|unset]   show or change the settings (Jira merge status, poll interval)
pr-tools-notifier reset [-y]            remove the saved token, settings and state (asks first; -y skips the question)
pr-tools-notifier send-test             send sample notifications
pr-tools-notifier run [-p PROFILE]      poll, notify and answer /todo and /mine

  -p, --profile NAME        gh-pr-tools profile (default: the only one)
      --interval 1m         time between polls: 90s, 5m, 1h (1m to 12h; overrides POLL_INTERVAL)
      --commands LIST       mine,todo (default: both)
      --once                poll once and exit
      --dry-run             print the messages instead of sending them
      --pr-tools PATH       run this gh-pr-tools entry script instead of `gh pr-tools`
```

`--dry-run` keeps its own state, so it never moves the baseline of a real run. Only one process may poll a given profile and command at a time; a second one stops with a message.

## How it behaves

- **Closed laptop.** The process sleeps with the machine. On wake it polls once and sends the changes in one message headed `🌅 Since HH:MM — N events`. It reports the net change, so something opened and resolved in between is not mentioned.
- **Delivery.** The baseline moves only after Telegram accepted the messages, so a failed send repeats the same events on the next poll. Telegram `429` and `5xx` are retried.
- **Failures.** After three polls in a row fail (an expired `gh` login, no network, a deleted profile), one `⚠️ Notifications are failing` message arrives. It explains the common causes in plain words (no connection to GitHub, a timeout, a rate limit, a `gh` login that expired, a missing profile, a gh-pr-tools too old for `--json`, Telegram refusing the bot) with what to check; anything else is shown as the raw error. The terminal always keeps the raw error. Another follows only after a successful poll.
- **Merge state `unknown`.** GitHub sometimes answers "unknown" while it recomputes whether a PR merges cleanly. The notifier keeps the last real answer for the same commit instead of guessing, so a PR with conflicts is not announced as ready. With no earlier answer, an approval says `GitHub is still checking whether the branch can be merged`.
- **Jira status.** A status that cannot be read for a moment (a failed lookup) keeps the last real one for the same ticket. The ticket moving back out of the merge status says `🟢 Review passed` again. Ticket and status are read from the `mine` snapshot only; `todo` is not affected.
- **Load.** One poll costs about 6 GitHub GraphQL points for `mine` and `todo` together. At the default 1-minute interval that is about 7% of the 5000-point hourly limit; a longer `POLL_INTERVAL` lowers it.
- **Format changes.** A state file written by another version is set aside as `*.corrupt` and the next poll starts a fresh baseline silently.

## Where things are stored

`~/.config/pr-tools-notifier/` (`$XDG_CONFIG_HOME` is respected):

| File                         | Content                                                |
| ---------------------------- | ------------------------------------------------------ |
| `config.json`                | bot username, chat id, the encrypted token             |
| `secret.key`                 | the key for the token (AES-256-GCM, mode 0600)         |
| `settings.env`               | your settings, see [Settings](#settings)               |
| `bot.json`                   | whether the bot greeted you, which answer is on screen |
| `state/<profile>-<cmd>.json` | the last snapshot, used as the baseline                |

The key sits next to the token, so the token stays out of backups, synced dotfiles and greps, but not from someone who can read the whole directory. Revoke a leaked token with `/revoke` in @BotFather and run `init` again. To remove everything, delete the directory.

## Maintenance

- **Changing your gh-pr-tools profile.** It is read on every poll, so changes apply without a restart. A different `REPO` or a new profile name starts a fresh baseline silently (state files of an old name stay in `state/`). A lower approval threshold can produce a 🎉 or 🚧 for PRs that now count as approved. A different GitHub username announces its pending review requests once.
- **Deleted profile or logged-out `gh`.** A profile name that does not exist, or a gh-pr-tools too old for `--json`, stops `run` at once when it shows up on the first poll. Later, every poll fails. After three, one `⚠️` message arrives with the reason and what to check (for example `gh pr-tools profile list`); then Telegram stays quiet until a poll succeeds, while the terminal keeps logging each failure. The state is kept, so restoring the profile for the same repo continues where it stopped.
- **Dead bot.** `pr-tools-notifier status` checks the token against Telegram. `run` does the same at start and stops with `getMe: 401 …` if Telegram rejects it. A token that dies later, or a bot you blocked, shows up in the terminal as `delivery: … 401` or `403` (Telegram cannot carry that alert). The events are kept and arrive after the fix: unblock the bot and press Start, or, for a deleted or revoked bot, stop `run`, run `pr-tools-notifier init` with a new token and start `run` again.
- **Removing everything.** Check what exists with `pr-tools-notifier status` (bot, last poll per profile, whether a `run` is active). `pr-tools-notifier reset` deletes `~/.config/pr-tools-notifier/` after asking (`-y` skips the question) and refuses while `run` is active. gh-pr-tools settings are not touched. The bot stays in Telegram until you send `/deletebot` (or `/revoke` for the token only) to @BotFather. To drop the command too, run `npm unlink -g pr-tools-notifier` (pnpm: `pnpm remove -g pr-tools-notifier`) and delete the clone.
- **Starting from scratch**, for a demo or a clean install: `reset` (it drops your settings too), then `init`, `send-test` and `run`. If you share your screen, the token is visible in the BotFather chat, so revoke it afterwards.

## Development

```bash
pnpm test           # vitest, one run (pnpm test:watch to watch)
pnpm type:check
pnpm check          # prettier; pnpm fix to format
```

`src/contract/snapshot.ts` holds the zod schemas that check the `gh pr-tools --json` documents; the format itself is described in the gh-pr-tools README. Sample documents are in `src/__tests__/fixtures/snapshots/`.

## License

Apache License 2.0, see [LICENSE](LICENSE).
