# pr-tools-notifier

Telegram notifications for your pull requests, on top of [gh-pr-tools](https://github.com/ek-hystax/gh-pr-tools).

A small process on your machine polls `gh pr-tools mine`, `todo` and, for the PRs and Jira tickets you follow, `track`, for each of your gh-pr-tools profiles (one per repo), compares each snapshot with the previous one and sends only what changed to your own Telegram bot. You can also ask the bot for your lists (`/todo`, `/mine`, `/tracked`). Nothing runs in the cloud and nothing listens for incoming connections: the bot only reads its own messages from Telegram.

```
💬 alice opened a thread
Should this be disabled while the request is in flight?
#101 PRJ-1001. Add export button                      [🔗 Open]

✅ carol approved · 2/2
🚧 Before merge resolve 2 threads, fix the failing CI and rebase the branch
#101 PRJ-1001. Add export button                      [🔗 Open]
```

## What you get

| Command | Notification                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mine`  | a new thread waiting for you (bot threads are compact and silent), an approval with the merge verdict, changes requested, CI failed                                            |
| `mine`  | 🎉 ready to merge, or 🚧 GitHub blocks the merge (for example, waiting for a code-owner team) — when it happens without a new approval                                         |
| `todo`  | review requested from you, a reply in a thread you started                                                                                                                     |
| `mine`  | with a Jira merge status (see [Waiting for Jira](#waiting-for-jira-optional)): ⏳ review passed, then 🎉 when the ticket reaches that status                                   |
| `track` | other people's PRs and Jira tickets you follow (see [Following PRs and tickets](#following-prs-and-tickets)): 🆕 a new PR for a ticket, ✅ review passed, 🟣 merged, ✖️ closed |

The approval verdict uses the approval threshold from your gh-pr-tools profile. Approvals given before a rebase or a small fix (stale) still count; the message then says `Approved 2/2 (2 stale)`, and GitHub's own merge state decides whether the merge is really allowed. Your own actions, threads you answered last and review requests on drafts never notify. Approvals below the threshold and bot threads arrive without a sound, and so does everything about a followed PR except the four events above.

## Setup

You need Node.js 22.16+, npm (or [pnpm](https://pnpm.io)) and [gh](https://cli.github.com/).

**1. gh-pr-tools and a profile.** The notifier reads `gh pr-tools <command> --json`, so make sure the extension is up to date (see its [README](https://github.com/ek-hystax/gh-pr-tools#readme) for the profile questions):

```bash
gh extension install ek-hystax/gh-pr-tools   # or: gh extension upgrade pr-tools
gh pr-tools init
```

A profile covers one repo; for another repo, run `gh pr-tools init` again with a new name (see [Several repos](#several-repos)).

**2. The notifier.**

```bash
git clone https://github.com/ka-hystax/pr-tools-notifier.git
cd pr-tools-notifier
npm install         # also builds dist/
npm link            # puts `pr-tools-notifier` on your PATH
```

With pnpm: `pnpm install` and `pnpm link --global` (run `pnpm setup` once if it complains about PATH). Without linking, use `node dist/cli.js <command>` instead of `pr-tools-notifier <command>`.

To update, run `git pull && npm install` in the clone; the linked command picks up the rebuilt `dist/`, and a `run` that is already going keeps the old code until you restart it. A new version may need a newer gh-pr-tools too, so run `gh extension upgrade pr-tools` as well.

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

It polls every gh-pr-tools profile you have; to poll only some, name them with `-p` (see [Several repos](#several-repos)). Keep it in a terminal tab or tmux. The first poll only records the current state (`first run, saved N PRs as the baseline`), so you are not flooded with old PRs.

### Asking the bot

While `run` is going, the bot also answers you. It has buttons under the input field and a `/` menu:

| Command     | Answer                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `/todo`     | PRs where you are a reviewer: 🔔 your turn (review requests, replies in your threads), then ⏳ waiting for authors |
| `/mine`     | your open PRs: ✅ approved (ready, or one fix away), then 👀 in review                                             |
| `/tracked`  | the PRs and Jira tickets you follow; `/track PRJ-1824 1281` adds, `/untrack` removes                               |
| `/status`   | the profiles, the last polls and the settings                                                                      |
| `/settings` | view and change the poll interval and the Jira merge status                                                        |
| `/help`     | what the bot can do (`/start` shows it too)                                                                        |

```
📤 Mine · 5 PRs · 15:49

✅ Approved · 2

#1216 PRJ-1865. Add CSV export…
🟢 ready to merge · 2/2 · 22d

#1281 PRJ-1824. Translate the settings page…
❌ CI failed · 🔀 conflicts · 3/2 · 3d


👀 In review · 3

#1291 PRJ-1826. Cache the model limits…
💬 2 open threads · 2/2 · 29h

#1289 PRJ-1992. Fix the table search…
⏳ review from ui, dave · 0/2 · 2d

#1295 PRJ-1993. Keep the date range in the URL…
📝 draft · 0/2 · 34m
                                          [🔄 Refresh] [✖ Close]
```

`/mine` puts a PR under **Approved** when it has enough approvals (stale ones count), no open threads, no requested changes, and GitHub is not waiting for a required review. A failed build, conflicts or a waiting Jira ticket keep it there: it is one fix or one wait away. Everything else is **In review**, with what you can answer first. `/todo` puts review requests and replies in your threads under **Your turn**, and the rest under **Waiting for authors** with your own verdict (`✅ you approved, new commits since`). The icons are the ones notifications use: ❌ CI, 🔀 conflicts, 💬 threads, 🔄 requested changes, ⏳ waiting, 🚧 GitHub blocks, 🎫 Jira, 📝 draft.

A list comes from the last poll when that is under two minutes old, otherwise from a fresh request (a few seconds; if GitHub cannot be reached, the last poll is shown with a note). `🔄 Refresh` asks again without touching what the notifications are compared against. Long lists get `Next ▶` and `◀ Prev`.

The bot keeps one answer on screen: asking for something else, or pressing `✖ Close`, takes the previous answer and your own command message down, so the chat holds notifications and the latest view, never old lists. Notifications are not deleted, and neither is the help message that holds the buttons, since Telegram removes a keyboard together with its message; `/help` brings a fresh one to the bottom.

Only the chat you connected is heard; messages from anyone else are ignored (the terminal says so once). A command older than two minutes, for example one sent while the laptop slept, is dropped instead of answered late. Only one `run` reads the bot's messages (`state/bot.lock`); a second `run` still sends its notifications, but one `run` for all your profiles is simpler.

### Waiting for Jira (optional)

If your team merges only after the ticket is moved to a status (a `Merge` column, say), tell the notifier which one:

```bash
pr-tools-notifier config set merge-status Merge
```

or in Telegram: `/settings` → `🎫 Jira status`, then send `Merge` as a message.

An approval that clears every blocker then says `⏳ Review passed · waiting for PRJ-1826 to reach the merge status (now: In Review)` instead of 🎉. When the ticket reaches the status, the 🎉 `Time to merge!` follows. If something still blocks the PR at that moment, the message lists it instead (`📌 PRJ-1826 moved to Merge`, `🚧 Before merge resolve 2 threads…`), and once the blockers are gone a second 🎉 says `PRJ-1826 is in Merge · no blockers left`. Several statuses can be given, separated by commas; names are compared without regard to case. They are the ticket's status names as Jira shows them on the ticket (in your Jira language), not the names of the board columns. See [Settings](#settings).

The ticket comes from gh-pr-tools, which already knows how to read Jira, so the notifier needs no credentials of its own. It takes the ticket key from the branch name (`bug/PRJ-1865`) or, failing that, the title (`PRJ-1865. Fix …`) and reads its status with the Jira token of your profile. Without one, add it once:

```bash
gh pr-tools -p PROFILE profile set jira-site yourorg
gh pr-tools -p PROFILE profile set jira-email you@example.com
gh pr-tools -p PROFILE profile set jira-api-token      # prompts, hidden
```

See the [Jira token](https://github.com/ek-hystax/gh-pr-tools#jira-token) section of gh-pr-tools for how to create the token. PRs with no ticket key in the branch or the title are announced as before. Without the token, the terminal warns `no Jira status came back` and the messages say `Jira status unavailable`, since the notifier cannot know whether the ticket is ready.

### Following PRs and tickets

QA engineers and managers often wait on PRs that are neither theirs nor theirs to review. Follow them by number or by Jira ticket, from Telegram or the terminal:

```bash
pr-tools-notifier track add PRJ-1824 1281 https://acme.atlassian.net/browse/PRJ-1744
pr-tools-notifier track                     # what is followed, and where the list is
pr-tools-notifier track rm 1281
```

In Telegram: `/track PRJ-1824 1281`, or `/track` alone (or `➕` under `/tracked`) and then the references as a message; `/untrack` and `➖` show a button per entry. A reference is a PR number, a PR link, a ticket key or a Jira link (a browse link, or a board link with `selectedIssue`).

A ticket stands for every PR whose title names it, so a follow-up PR opened after testing shows up by itself (`🆕 New PR for PRJ-1824`). `/tracked` shows a ticket with its open PRs, or with the last merged one once none is open; PRs closed without merging are left out.

```
📌 Tracked · 3 · 15:49

🎫 PRJ-1744 · In Review
#1273 Audit log: backend… · alice
✅ review passed · 2/2 · 9d
#1274 Audit log: settings page… · alice
⏳ review from ui · 1/2 · 9d

🎫 PRJ-2050 · To Do
no PR yet

#1290 Faster CSV export · bob
🔄 changes requested by carol · ❌ CI failed · 1/2 · 🎫 In Review · 4d
                          [➕ Add] [➖ Remove]
                          [🔄 Refresh] [✖ Close]
```

Notifications about a followed PR say whose it is (`📌 #1273 … · alice`). With a sound: a new PR for a ticket, ✅ review passed (enough approvals and nobody asking for changes; CI and conflicts do not stop testing), 🟣 merged and ✖️ closed. Without a sound: changes requested, a failed CI and CI passing again after a failure, conflicts, a Jira status move (`🎫 PRJ-1824: In Review → Approved`), approvals below the threshold and new threads (one short line each). Your own PRs are left to `mine` while it is polled. Once something is done, a `🧹 Clear done` button appears: it removes the PRs that merged or closed and the tickets whose PRs all did; nothing is removed by itself.

The list is a plain file, `~/.config/pr-tools-notifier/tracked/<profile>.txt`, one reference per line (`#` starts a comment), the format of gh-pr-tools' `track --list`. It is read again on every poll, so an edit by hand applies on the next one. Tracking needs gh-pr-tools from October 28, 2026 or later (`gh extension upgrade pr-tools`). With an older one, `mine` and `todo` keep working, but every poll of the list fails, and after three in a row the `⚠️` message says to update. While the list is empty, nothing is polled for it.

### Several repos

One gh-pr-tools profile covers one repo, and two profiles cannot share a repo, so following a ticket of another team's repo needs a profile of its own (`gh pr-tools init`). With several, a single `run` polls them all, each on its own schedule of the same interval. Without `-p` that means `mine`, `todo` and `track` for every profile; name them to choose, and add `:LIST` to poll only some commands for a profile, for example only the PRs you follow in another team's repo:

```bash
pr-tools-notifier run -p web -p ops:track
```

`run` looks the profiles up when it starts, so restart it after adding one. Each notification then names the repo after the title (`#412 Rotate the backup keys · dave · ops`), a failure alert names its profile, and every terminal line starts with it. In the bot, `/mine`, `/todo` and `/tracked` show a section per profile that polls them (`🗂 ops`), and `/status` lists each profile.

`/track` finds the profile of what it adds:

- a PR link goes to the profile of its repo;
- a ticket goes where gh-pr-tools finds PRs naming it; with none yet, to the profile whose Jira prefix takes it (each profile is asked once, which takes a few seconds);
- a PR number, or a ticket that fits several profiles, is asked about, with a button per profile (and `All of them` for a ticket with PRs in several repos).

`/untrack` takes a ticket off every list that has it, and a PR link only off the list of its repo; a PR number that two lists name is asked about. In the terminal, `pr-tools-notifier track` needs `-p PROFILE` once there are several profiles.

```
📌 Tracked · 2 · 15:49

🗂 web
#1290 Faster CSV export · bob
🔄 changes requested by carol · 1/2 · 4d


🗂 ops
🎫 OPS-31 · In Review
#412 Rotate the backup keys · dave
⏳ needs approvals · 0/2 · 2d
```

### Settings

Two optional settings live in `~/.config/pr-tools-notifier/settings.env`, one `KEY=value` per line (`#` starts a comment). Change them in Telegram with `/settings` (the interval with a preset button or as a message such as `2m`, the Jira status as a message), edit the file by hand, or use the command:

```
pr-tools-notifier config                       show the settings and where the file is
pr-tools-notifier config set KEY VALUE         change one (quote a value with spaces)
pr-tools-notifier config unset KEY             remove one
```

| Key             | Value                                                                   | Default |
| --------------- | ----------------------------------------------------------------------- | ------- |
| `MERGE_STATUS`  | Jira statuses that mean "time to merge", comma-separated: `Merge,Ready` | none    |
| `POLL_INTERVAL` | time between polls: `90s`, `5m`, `1h`; from `1m` to `12h`               | `1m`    |

`config set` accepts the key in any case and with `-` for `_` (`merge-status`). A running `run` re-reads the file and applies a change within a minute, no restart needed. A typo stops `run` at start with the file and line, instead of being silently ignored; while running, a broken file keeps the last good settings and the terminal says why. The `--interval` option of `run` overrides `POLL_INTERVAL` for one run.

## Commands

```
pr-tools-notifier init                  set up your bot (once)
pr-tools-notifier --version             print the version
pr-tools-notifier status                show the bot, its check against Telegram and the saved state
pr-tools-notifier config [set|unset]   show or change the settings (Jira merge status, poll interval)
pr-tools-notifier reset [-y]            remove the saved token, settings and state (asks first; -y skips the question)
pr-tools-notifier send-test             send sample notifications
pr-tools-notifier track [add|rm REF...] show or change the PRs and Jira tickets you follow (-p PROFILE)
pr-tools-notifier run [-p PROFILE]...   poll, notify and answer the bot's commands

  -p, --profile NAME[:LIST] gh-pr-tools profile to poll, repeat for several (default: all of them);
                            LIST polls only those commands for it, e.g. -p ops:track
      --interval 1m         time between polls: 90s, 5m, 1h (1m to 12h; overrides POLL_INTERVAL)
      --commands LIST       mine,todo,track (default: all; track only polls a non-empty list)
      --once                poll once and exit
      --dry-run             print the messages instead of sending them
      --pr-tools PATH       run this gh-pr-tools entry script instead of `gh pr-tools`
```

`--dry-run` keeps its own state, so it never moves the baseline of a real run. Only one process may poll a given profile and command at a time; a second one stops with a message.

## How it behaves

- **Closed laptop.** The process sleeps with the machine. On wake it polls once and sends the changes in one message headed `🌅 Since HH:MM — N events`. It reports the net change, so something opened and resolved in between is not mentioned. With several profiles, each sends its own.
- **Delivery.** The baseline moves only after Telegram accepted the messages, so a failed send repeats the same events on the next poll. Telegram `429` and `5xx` are retried.
- **Failures.** After three polls in a row fail (an expired `gh` login, no network, a deleted profile), one `⚠️ Notifications are failing` message arrives. It explains the common causes in plain words (no connection to GitHub, a timeout, a rate limit, a `gh` login that expired, a missing profile, a gh-pr-tools too old for `--json`, Telegram refusing the bot) with what to check; anything else is shown as the raw error. The terminal always keeps the raw error. Another follows only after a successful poll. With several profiles, each counts its own failures and the message names it. Running out of the GitHub rate limit gets a message of its own at once instead: how far into the hour it ran out, when polling resumes, and the poll interval that would have lasted the hour at that pace (twice the current one if it ran out half an hour in).
- **Merge state `unknown`.** GitHub sometimes answers "unknown" while it recomputes whether a PR merges cleanly. The notifier keeps the last real answer for the same commit instead of guessing, so a PR with conflicts is not announced as ready. With no earlier answer, an approval says `GitHub is still checking whether the branch can be merged`.
- **Jira status.** A status that cannot be read for a moment (a failed lookup) keeps the last real one for the same ticket, in `mine` and `track`. The ticket moving back out of the merge status says `⏳ Review passed` again. The merge status applies to `mine` only; `todo` and `track` are not affected.
- **Load.** Polls count against the GitHub limit of your `gh` login, 5000 GraphQL points an hour, shared by every profile, gh-pr-tools tables (`--watch` too) and anything else using that login. A command costs a few points plus about 2 for each PR in its list, since reading the review threads is the expensive part: `mine` with 8 PRs costs about 17, `todo` with 9 about 22, a tracked list with one ticket about 4. An hour costs (60 / interval in minutes) times the sum over every profile and command it polls, so `mine` and `todo` of one busy repo every minute take about half the limit, and `gh pr-tools todo --watch` adds a `todo` every 5 minutes. Poll only what you need (`--commands track`, `-p NAME:track`) or set a longer `POLL_INTERVAL` to lower it.
- **Format changes.** A state file written by another version is set aside as `*.corrupt` and the next poll starts a fresh baseline silently.

## Where things are stored

`~/.config/pr-tools-notifier/` (`$XDG_CONFIG_HOME` is respected):

| File                         | Content                                                |
| ---------------------------- | ------------------------------------------------------ |
| `config.json`                | bot username, chat id, the encrypted token             |
| `secret.key`                 | the key for the token (AES-256-GCM, mode 0600)         |
| `settings.env`               | your settings, see [Settings](#settings)               |
| `bot.json`                   | whether the bot greeted you, which answer is on screen |
| `tracked/<profile>.txt`      | the PRs and Jira tickets you follow                    |
| `state/<profile>-<cmd>.json` | the last snapshot, used as the baseline                |

The key sits next to the token, so the token stays out of backups, synced dotfiles and greps, but not from someone who can read the whole directory. Revoke a leaked token with `/revoke` in @BotFather and run `init` again. To remove everything, delete the directory.

## Maintenance

- **Changing your gh-pr-tools profile.** It is read on every poll, so changes apply without a restart; a new profile needs a restart of `run`. A different `REPO` or a new profile name starts a fresh baseline silently (state files of an old name stay in `state/`). A lower approval threshold can produce a 🎉 or 🚧 for PRs that now count as approved. A different GitHub username announces its pending review requests once.
- **Deleted profile or logged-out `gh`.** A profile name that does not exist, or a gh-pr-tools too old for `--json`, stops `run` at once when it shows up on the first poll, together with the other profiles it polls. Later, every poll fails. After three, one `⚠️` message arrives with the reason and what to check (for example `gh pr-tools profile list`); then Telegram stays quiet until a poll succeeds, while the terminal keeps logging each failure. The state is kept, so restoring the profile for the same repo continues where it stopped.
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
