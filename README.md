# Y$ER Journal Bot

Discord journaling bot built on discord.js 14 and Sapphire. Everything is Components V2.

- `/journal [picture]` opens a panel: outcome (Win / Loss / Breakeven / Missed), modals for trade details, result (PnL), notes and picture, a forum select, then Preview / Post / Cancel.
- Posts land in a forum as a tagged post. The picture sits above the journal text. Your four journal formats are reproduced, with one extra `PNL:` line in the results section.
- The bot scans every journal forum, parses each post's `PNL:` line and totals PnL by day, week and month.
- Weekly image (calendar, five weekdays, weekend folded into the total) is posted to a report channel at the day and time you choose.
- Month-end image (every day of the month) is posted on the last day of the month.
- **Import from CSV** sits at the bottom of the `/journal` panel: upload a trade-history export (Hyperprop, Tradovate, TopstepX, NinjaTrader or any sheet with a symbol and PnL column). A preview shows the net PnL, a running-PnL sparkline, how many wins / losses / breakevens and where each group will post; **Import** then posts every trade into its outcome's destination with a live progress bar. Fees are taken off, rows it can't read are listed, and trades already imported are skipped, so the same file can be uploaded again safely (up to 400 trades per run).
- `/journal-settings` opens a Components V2 settings panel (General / Outcome forums / Schedule / Appearance / Advanced).
- **Accounts** (prop firm mode): one account per eval, funded or personal account, each with its own rules, all set in the bot: profit target, daily loss limit, max drawdown (static, trailing, or end-of-day trailing; both trailing kinds stop at the starting balance), minimum trading days, consistency (best day at most N% of profit) and profit split. New accounts start from a typical template to edit to the firm's real numbers.
  - Trades are tagged with an account when you post with `/journal`, import a CSV (an "Into account" picker in the preview) or edit them (`/edit-trade` can move a trade). Untagged trades belong to the default account; changing the default pins the old one's history first.
  - `/account` shows the dashboard: the balance, a target ring, the room above the drawdown floor as a fuel gauge, today against the daily limit, the balance line with the floor trailing under it and the target above, the rule tiles, and the journey (Eval #1 breached, Eval #2 passed, Funded). Studio or Night.
  - The **alerts channel** gets warnings at 50% and 80% of the daily limit or the drawdown, 90% of the target, a breach (the run is marked breached, with "Start attempt #N" and "Not a breach"), and a passed evaluation with **Move to funded**. Funded accounts log payouts with your split. Each alert is sent once per day (milestones once per run).
  - `/trades` gets an account picker; `/pnl day|week|month` an `account` option. Cards for one account carry its badge.
  - The bot only knows what is journaled, so the dashboard is an estimate; **Correct balance** lines it up with the platform.
- Every panel (settings, pickers, forms) uses the dark accent; colour is kept for outcomes and alerts. Everything is Components V2.
- **Appearance** sets the theme for every image the bot draws: **Studio** (light, the landing page look), **Night** (matte: one flat charcoal floor with a quiet dot grid, flat panels with hairline outlines in their outcome colour and a short solid index tab on top, flat chart fills, no gradients, glows or shadows), or **Auto** (Studio by day, Night from 19:00 to 07:00 in the server's timezone). The page shows today's card in both themes side by side, with the active one ringed, plus preview buttons for the day, week and month. Night references: `assets/reference/dark-*.png`; `node scripts/render-dark-samples.js` renders every sample in Night.
- `/trades`: a private period picker (Today / This week / This month). Picking one draws the trade ledger: the net and win rate, profit factor, average win and loss, best streak, long vs short, a won-vs-lost bar with the symbols traded, then every trade as a row (time, symbol and side, size, entry to exit, hold time, R, a PnL bar and the PnL), grouped by day for a week or month, with page buttons for long periods.
- `/edit-trade`: a private trade finder for adding a chart or notes later, or fixing a number. Filter by period (today, this week, this month, last 30 days, all time), outcome and symbol, switch the lens (newest, biggest PnL, missing a chart, missing notes) or search (symbol, side, setup, notes, a day or an amount). The list is numbered with jump links, and the picker below uses the same numbers. Picking a trade opens it with the same forms as `/journal`; nothing changes until **Save**, which rewrites the post in place (text, chart, and the title for one-trade-per-post entries) and updates `/pnl` and `/trades`. Only trades the bot posted can be edited.
- `/pnl day [date]` (a 4:5 daily card: the day's PnL as one smooth curve, the outcome dots, and best trade, win rate and week-so-far tiles), `/pnl week [date]`, `/pnl month [YYYY-MM]`, `/pnl rescan`.
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
