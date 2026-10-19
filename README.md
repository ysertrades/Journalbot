# Y$ER Journal Bot

Discord journaling bot built on discord.js 14 and Sapphire. Everything is Components V2.

- `/journal [picture]` opens a panel: outcome (Win / Loss / Breakeven / Missed), modals for trade details, result (PnL), notes and picture, a forum select, then Preview / Post / Cancel.
- Posts land in a forum as a tagged post. The picture sits above the journal text. Your four journal formats are reproduced, with one extra `PNL:` line in the results section.
- The bot scans every journal forum, parses each post's `PNL:` line and totals PnL by day, week and month.
- Weekly image (calendar, five weekdays, weekend folded into the total) is posted to a report channel at the day and time you choose.
- Month-end image (every day of the month) is posted on the last day of the month.
- `/journal-settings` opens a Components V2 settings panel (General / Outcome forums / Schedule / Advanced).
- `/pnl day [date]` (a 4:5 daily card: the day's PnL, every trade on "the tape" with a running-PnL step chart, and the week around it), `/pnl week [date]`, `/pnl month [YYYY-MM]`, `/pnl rescan`.
- Message context menu **Edit journal PnL**: override the PnL of any journal post (used for the images, post text unchanged).

It does not register or touch any `/settings` command.

## Setup

1. Developer Portal → your bot → **Privileged Gateway Intents** → enable **Message Content Intent**. This is how the bot reads the `PNL:` line in posts, including ones you wrote by hand.
2. Invite with scopes `bot` + `applications.commands`. Permissions in the journal forums: View Channel, Send Messages, Send Messages in Threads, Create Public Posts, Attach Files, Read Message History, Manage Threads (Manage Threads lets the bot reopen an archived post). In the report channel: View, Send, Attach Files.
3. `cp .env.example .env`, then set `DISCORD_TOKEN`, `OWNER_ID` (your user id) and, while testing, `GUILD_ID`.
4. `npm install`, then `npm start` (Node 20+).
5. In Discord run `/journal-settings`. **Outcome forums**: press **Choose** next to Win / Loss / Breakeven / Missed, pick the forum, then pick the existing post inside it (the list shows that forum's posts, newest first, with Previous/Next). Trades for that outcome are then added as messages inside that post instead of creating a new post. Choose **New post each time** if you want a fresh post per trade in that forum. **General**: a default forum (used for any outcome with nothing set), the report channel, and optional extra forums to scan. **Schedule**: weekly day/time, month-end time, timezone (default America/New_York). **Advanced**: currency, R multiples, ping role, allowed users, previews, "post now", rescan and the health check.
6. Run `/pnl rescan` once to pull in your existing posts.

### Forum tags (only for "New post each time")
When the bot creates a new post it can tag it. Create tags named `Win`, `Loss`, `Breakeven`, `Missed` on each journal forum. The bot applies the matching tag when posting and uses tags to decide the outcome when scanning. Without tags it falls back to the post heading, then to the sign of the PnL.

### Custom emojis (optional)
Upload your pill icons to the server named `ywin`, `yloss`, `ybe`, `ymissed`. Unicode fallbacks are used if they are missing.

## How PnL is read
- Looks for a line like `PNL: +1250`, `+ PNL: 1,250` or `- PNL: 480` in the starter post. Missed posts count as 0 (the `POTENTIAL:` line is shown but never counted).
- Loss is always negative and Win always positive, whatever you type. Breakeven is as typed.
- The date comes from the post's date line; if absent, from when the post was created, in your timezone.
- Posts without a `PNL:` line are ignored in totals and listed after `/pnl rescan`.
- When an outcome points to an existing post, every message in that post that has a `PNL:` line is its own trade (messages without one are ignored, so you can chat in the post). In a Missed post a message counts only if it is marked MISSED. Trades typed by hand in that post are picked up too, and edits or deleted messages update the totals.
- Edits to the starter post, tag changes and deleted posts update totals automatically. A nightly rescan (03:30) catches anything missed while the bot was offline.
- Manual overrides from **Edit journal PnL** are kept until you run a forced rescan from code.

## Scheduling
A once-a-minute tick checks every configured server. Each report is logged once per period (`report_log`), so restarts never double-post. If the bot was offline at the scheduled time it posts late (up to 6 hours after) and marks it "posted late". Failed posts retry up to 3 times, then DM the owner.

## Hosting notes
SQLite lives at `./data/journal.sqlite` (override with `JOURNAL_DB_PATH`). On a host with an ephemeral disk, mount a volume and point `JOURNAL_DB_PATH` at it. If it is lost, `/pnl rescan` rebuilds PnL from the forums; only your settings need re-entering.

## Adding to an existing Sapphire bot
Copy `src/commands`, `src/interaction-handlers`, `src/listeners`, `src/lib`, `assets/fonts`, add the dependencies from `package.json`, and request the intents from `src/index.js`. Tables are prefixed `journal_`, `pnl_` and `report_log`, so nothing collides.

## Scripts
- `npm test` runs the unit and flow tests.
- `npm run render-samples` writes sample weekly/monthly images to `tmp-samples/`.
- `node scripts/smoke-load.js` loads every command, handler and listener without logging in.
