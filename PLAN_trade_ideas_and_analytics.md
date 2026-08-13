# Year-over-Year / Seasonality / Sector / Risk Analytics + Ollama Trade-Idea Generator

Draft plan for review — nothing has been built yet.

## Why

Right now the local companion app can't answer questions like "am I doing better this year than last year," "what's my best month or day of the week to trade," "how concentrated am I in one sector," or "what's my actual net market exposure across all my open positions right now." On top of that, its Ollama chat ("Plutus") only responds reactively when you ask it something — it doesn't proactively dig through your historical performance plus live market data and hand you a written set of trade ideas to review.

## Scope — local app only, confirmed hard boundary

**Everything in this document applies exclusively to the local companion app (`local/server.js`, `local/local-dashboard.html`, and other new files under `local/`).** The GitHub Pages static app (`index.html`, everything under `js/`, and anything else served at `https://ossaenz.github.io/TG_Capital/`) is **not touched by any part of this plan** — no new files there, no edits there, nothing read from or written to `js/` or `index.html`. Earlier drafts of this plan included a "both apps" version of Phase 1 (parallel JS implementations in `js/analytics.js`, a `js/data/sector-map.json` export step, new Reports-tab sections in `index.html`) — **that cross-app portion is dropped entirely.** Everything below is local-app-only.

## Constraints that shape the design

1. **Nothing outside `local/` gets read, modified, or created.** All new SQL, new tables, new routes, new dashboard sections, and new supporting `.js` modules live under `local/`. If a future idea would require touching the static app to work, it gets flagged as out of scope rather than implemented.
2. **This reuses the local server's own SQL-based calculations, not the static app's engine.** The local server already has its own independent reimplementation of P&L/position logic over its SQLite `trades` table (`computeDashboard`/`computeBreakdown` in `local/server.js`) — everything new here extends that, and never reads or reimplements `js/engine.js` (the static app's separate lot-matching engine).
3. **The LLM never computes numbers, only narrates them.** Local LLMs (including whatever you're running via Ollama) are unreliable at actually calculating indicators or option greeks from raw data — they're fine at *defining* RSI/MACD (that's well-documented, heavily-trained-on textbook knowledge), but bad at *computing* them from a price series you hand them. So every number in a report — RSI, MACD, support/resistance, IV rank, strike/delta candidates — is computed deterministically in code. The LLM's only job is to rank and write up 2-3 ideas from data it's given, never to invent a number.

## What I found in `spy-dashboard` (your other project)

You asked me to check `/media/osaenz/2ndsk1/github/spy-dashboard` for how it decides when to suggest a SPY trade. Worth knowing before finalizing this plan:

- **It's not actually a computed signal engine.** The strikes/deltas/IV-rank numbers you see there are mostly static playbook text with live price plugged into fixed %-OTM formulas (e.g. Monthly short strike = `price × 0.975`) — there's no real RSI/MACD/moving-average calculation, no real support/resistance (it's flat ±1%/±2% bands), no real option-chain delta lookup, and IV rank is always displayed as `—` (never actually computed).
- **What it *does* have that's genuinely useful and worth reusing:** a VIX-based buying-power scaling rule (>40 VIX → 100% of base size, ≥30 → 80%, ≥20 → 70%, ≥15 → 60%, else 50%), a day-of-week trading plan, hard risk rules (no 0DTE through CPI/FOMC/earnings, VIX spike >5% intraday halts new trades, Friday exit rules), a portfolio allocation split across 0DTE/Weekly/Monthly/LEAP buckets (20/25/35/15%), and a position-sizing formula (max contracts = risk budget ÷ max loss per contract, with per-bucket profit-target/stop-multiple defaults).
- **The plan below borrows the second part** (the proven playbook rules) as deterministic logic in the new trade-idea generator — not as a fuzzy RAG document, as hard-coded rules/constants, since these are exact numeric thresholds, not prose to retrieve. It replaces the first part (the static/fake indicators) with the real computed indicators this plan already calls for (real RSI/MACD, real Schwab option-chain delta, real support/resistance). Net effect: SPY-specific trade ideas end up more rigorous than either app currently produces alone, using rules you already trust and use.

## UI structure: two named dashboard tabs (local app only)

You asked for this to be organized as two new top-level tabs on the local dashboard: **"Performance Coach"** and **"Proactive Scout"**, each with its own URL and clearly separated code, without touching any existing tab/route/API. That maps cleanly onto everything below:

- **Performance Coach** = Phase 1 (YoY/seasonality/sector/risk) **plus** the new leak-analysis, risk-thermometer, and win-rate-by-setup items added below.
- **Proactive Scout** = Phase 2 (trade-idea generator) + Phase 3 (scheduling/email) **plus** the new confluence-alert engine and catalyst-scanning items added below.

**Hard constraint — vanilla JS only, confirmed:** the spec these names came from assumes a React/Next.js app (React Router, TypeScript `.ts`/`.tsx` files, Tailwind/MUI components, `getTrades()`-style data hooks). None of that gets introduced here. No React, no TypeScript, no JSX, no Router library, no CSS framework, no build step/bundler/transpiler, no new npm dependency for UI purposes — everything stays plain `.js`/`.html`/inline `<script>`, matching every other file in this app exactly. The local app is a single Express server (`local/server.js`) serving one large static HTML file (`local/local-dashboard.html`) with plain inline `<script>` JS (view-switching today is a `showTab('analytics'|'insights'|'journal')`-style function, see `local-dashboard.html:459-461`). The plan below keeps the *same functional ideas and separation of concerns* (new tabs, new isolated modules, read-only reuse of existing functions, nothing existing touched) but implements them as:
- Two new entries in the existing `showTab()` nav pattern (`#tab-performance-coach`, `#tab-proactive-scout`) instead of React Router routes.
- New plain `.js` files under `local/` (e.g. `local/tradingInsights.js`, `local/riskMetrics.js`, `local/catalystScanner.js`, `local/indicators.js`, `local/mailer.js`) instead of `.ts` service modules — same separation of concerns, just matching the file type already used everywhere else in this app.
- New `<div id="performance-coach-view">` / `<div id="proactive-scout-view">` sections in `local-dashboard.html`, styled with the existing inline CSS conventions already in that file (no Tailwind/MUI in this codebase), instead of new React components.
- New Express routes under the same `/api/...` convention already used (e.g. `/api/analytics/*`, `/api/scout/*`) instead of Next.js API routes.

Nothing about the **content or intent** of the spec changes — every sub-feature below is a direct, literal implementation of what was asked, just expressed in this app's actual stack. Existing routes, `/app` (the cloned static-app copy), the existing dashboard tabs (Analytics/Deep Insights/Trade Journal), and all current API behavior stay exactly as they are — the two new tabs are additive.

## Phase 1 — "Performance Coach": Year-over-Year, Seasonality, Sector, Risk, Leak Analysis

No risky new dependencies — this phase is pure data aggregation over data you already have.

**What you'd see:**
- Year-over-year comparison (this year vs. last year vs. prior years), month by month.
- "Best month" and "best day of the week to trade" cards.
- Sector breakdown (e.g. Technology vs. Consumer Discretionary vs. Index/ETF) showing P&L concentration.
- **Portfolio-level Greeks exposure** — aggregate delta/theta/vega across all your currently open positions, so you can see net directional exposure at a glance instead of only per-position numbers.
- **Assignment-risk / expiration calendar** — a view flagging short options going in-the-money as expiration approaches, so rolling/closing/accepting assignment is a deliberate choice.
- **Concentration/correlation warning** — flags when a sector or ticker is already a large share of your book, using the same sector-map data.
- **Benchmark comparison** — your realized P&L vs. simply holding SPY over the same period.

**How it's built (all inside `local/`):**
- New SQL queries in `local/server.js` grouped by year/month/day-of-week.
- A `sector_cache` SQLite table populated by calling Finnhub's company-profile API per traded ticker (you likely already have a Finnhub key from `spy-dashboard`, so this may need no new signup — same key, new env var `FINNHUB_API_KEY` in `local/.env`). This cache is used only by the local dashboard — no export step, no static JSON file, nothing written outside `local/`.
- Greeks/assignment-risk pull from the option-chain data the app already fetches via Schwab.
- Benchmark comparison needs SPY's own historical prices (already fetchable via the existing Schwab price-history call).
- New charts (year-over-year line, sector doughnut/bar, benchmark-vs-SPY line) added to `local/local-dashboard.html` only.

**Known limitation:** "best time of day to trade" isn't possible from data synced so far — transaction data currently stores date only, no timestamp. **But this is fixable going forward:** I checked `local/sync-schwab.js:82-88` — Schwab's transaction API actually returns a full timestamp (`tradeDate`/`time`), and the sync code's `toMMDDYYYY()` helper immediately truncates it to date-only before storing. Capturing that time component in a new `trades.time_iso` column (or just not truncating it) would unlock real time-of-day analysis for everything synced from here on — historical trades would need a manual re-sync to backfill (Schwab's transaction history is available for a limited lookback window, so full backfill may not reach every historical trade). Flagging this as a small, worthwhile Phase 1 addition rather than leaving it as a permanent limitation.

### New: "Why" trading-leak analysis

A dedicated module, `local/tradingInsights.js`, that takes closed trades + journal entries (which already have a `strategy` field — confirmed in both apps' journal schema, e.g. `local/rag.js`'s `journal_entries.strategy` column) and computes:
- **Win rate / avg P&L / total P&L by strategy tag** — directly buildable today from existing journal strategy tags. Rendered as a "Win Rate by Setup" table (Strategy, Trades, Win Rate, Avg P&L, Total P&L).
- **P&L by holding period** (scalp vs. swing) — buildable today from `openDate`/`closeDate` already on every closed trade.
- **P&L by day of week** — already planned above (seasonality), reused here.
- **P&L by time of day** (open/mid/close session buckets) — only once the time-of-day capture fix above is in place; until then this bucket stays empty/hidden rather than showing fake data.
- A small deterministic rule-set that turns those numbers into plain-English bullet insights (no LLM involved — these are backward-looking facts, not judgment calls), e.g. "Your [strategy] setups have a 32% win rate over 40 trades and are your single biggest drag (-$X) — you trade this often but it loses money," or "You lose money more often on [weekday] than any other day." Same "deterministic-first" principle as the rest of this plan — a template-based generator, not free-form LLM narration, since these are just derived facts.
- **R-multiple / risk-adjusted return by year** was in the original ask, but a raw R-multiple doesn't translate cleanly to an options premium-selling book the way it does for futures/forex — I'd substitute **profit factor per year** (gross wins ÷ gross losses, already computed elsewhere in this app) as the risk-adjusted metric, unless you specifically want a defined "R" (e.g. risk = max loss on the trade) computed per trade instead.
- **"Most consistent year (lowest drawdown)"** — approximated via a simple running-drawdown calc over each year's daily P&L curve (peak-to-trough dollar or % decline), not a full formal drawdown model.

### New: Risk Thermometer (margin/leverage gauge)

The raw fields already exist — no new API calls needed. `fetchLiveAccountSnapshot()` (`local/server.js:922-974`) already returns `balances.marginBalance`, `balances.equity`, `balances.buyingPower`, and `balances.liquidationValue` from Schwab. New `local/riskMetrics.js` computes a margin-usage ratio from these (exact formula needs a quick sanity check against Schwab's field semantics at implementation time — likely something like `marginBalance / equity` or `1 - buyingPower/liquidationValue`) and buckets it into three configurable bands:
```
GREEN:  ratio < 0.25   — "Safe: margin usage is conservative."
YELLOW: 0.25–0.5       — "Warning: you're pushing leverage, consider reducing size."
RED:    ratio >= 0.5   — "Danger: extreme margin usage. Consider closing positions."
```
Displayed as a gauge (a simple colored bar/radial built with plain CSS/canvas, no new charting library needed) plus a small sparkline of the ratio over recent days — which needs the ratio snapshotted periodically (piggyback on the existing sync/refresh cycle rather than adding new polling).

## Phase 2 — "Proactive Scout": Ollama Trade-Idea Generator + Confluence Alerts + Catalyst Scanning (local app only)

For a handful of tickers (ones you've traded before, plus SPY explicitly, or a configurable watchlist), it pulls together:
- Live quote, option chain (with IV), and price history from Schwab (already wired up today).
- RSI and MACD, computed from that price history via a small, well-established `technicalindicators` npm library — not hand-rolled math.
- A VIX read for market-wide context.
- **Your own historical performance on that specific ticker** — win rate, average win/loss, how that setup has actually gone for you before.
- Relevant past journal notes on that ticker, if any (reusing the existing semantic-search/RAG feature).
- Earnings-date awareness — skip/flag a candidate if earnings fall before the proposed expiration (IV-crush/gap risk).
- **For SPY specifically:** the borrowed playbook rules from `spy-dashboard` (VIX-based sizing tier, day-of-week plan, bucket selection across 0DTE/EOD/Weekly/Monthly/LEAP, earnings/FOMC/CPI blackout rules) layered on top of the real computed indicators/greeks, instead of the static %-offset strikes that dashboard currently uses.

All the actual numbers are computed deterministically in code — the LLM is only asked to rank and write up 2-3 candidate ideas in plain English from that pre-computed data. This is deliberate: local LLMs have no real edge at predicting market direction, and framing this as "prediction" risks generating confident-sounding but baseless guidance on real money. Framed instead as: "here's what the data says, here's what similar setups did for you historically, here's the house rule that applies — you decide."

Every generated report is saved (including the exact data digest fed to the LLM, not just what it wrote) so you can double-check the LLM didn't drift from the real numbers. Shown on the dashboard with price + RSI/MACD line charts per ticker.

**Explicit non-goal:** this does not place trades, does not claim to predict price direction, and is not personalized financial advice — it's a research aid for a decision you make yourself.

### New: Confluence alert engine (separate from full trade-idea reports)

A lighter-weight, standalone alerting layer, distinct from the full multi-ticker report above — this watches a **watchlist you manage directly in the UI** (simple add/remove ticker list, stored in a new small table) and fires an alert only when multiple signals line up, rather than generating a full written report every time. New `local/indicatorEngine.js` (the RSI/MACD math is the same `technicalindicators`-backed code as Phase 2 above — one shared module, not duplicated):
- `RSI < 30` (oversold) or `> 70` (overbought)
- MACD line crossing above/below its signal line
- Volume spike above a configurable multiple of average volume
- An alert only fires when **2-3 of these align in the same direction** (bullish/bearish) — configurable threshold, avoids noise from any single indicator twitching.
- Alerts table on the dashboard: Ticker, Direction, RSI value, MACD status, Volume status, Timestamp, with an "Acknowledge" action (so dismissed alerts stop nagging you). Stored in a new small table, not just ephemeral in-memory state, so acknowledgment persists across restarts.
- When "real-time alert emails" is toggled on (see below), a fired confluence alert can also trigger `sendAlertEmail()`.

### New: Catalyst scanning (geopolitical + market seasonality)

Two different things than the personal-history seasonality in Phase 1 — this is *market-level* context, not your own trade history:
- **Geopolitical catalysts** — rather than adding a brand-new news API/key, this should reuse the **Perplexity web-search integration the local app already has** (per `local/.env.example`'s `PERPLEXITY_API_KEY`, already used for the existing chat's web-search tool) to periodically ask a scoped question like "notable geopolitical/macro developments likely to affect equity/options markets this week" and structure the response into `{ region, description, likelyImpactedSectors, confidence }` — cheaper and simpler than standing up a second news-API integration from scratch, since the plumbing (API key, request pattern) already exists in this file.
- **Market seasonality (by sector)** — general, well-documented patterns ("tech tends to outperform in Q4," "sell in May," sector rotation calendars) are the kind of thing most LLMs already know reasonably well from training (same point made earlier about textbook technical-analysis knowledge) — this can be a small static reference table (`local/seasonalityPlaybook.js`) rather than something computed from scratch, refined over time if specific patterns prove unreliable.
- Both surfaced as read-only reference panels on the Proactive Scout tab — **not** wired into position sizing or automatically acted on; they're context for the trade-idea generator's narrative and for you to read directly.

## Phase 3 — Scheduling + Email

- A cron schedule (e.g. weekday mornings before market open) regenerates the full trade-idea report automatically, on top of an on-demand "generate now" button.
- Emailed to you via Gmail SMTP using an App Password (simplest reliable option for a personal script — no OAuth consent flow to build/maintain).
- **Dashboard UI controls** (not just an env-var cron string): a toggle for "Daily Email Summaries," a separate toggle for "Real-time Alert Emails" (confluence alerts above), and a time picker for the daily summary send time — read/write through a small settings table so toggling doesn't require editing `.env` and restarting the server.
- Daily summary content: recap of catalysts detected, top 3-5 tickers with the strongest confluence signals, brief per-idea rationale — essentially a lighter digest version of the full trade-idea report, reusing the same underlying data.
- A scheduled run that fails silently (Ollama down, Schwab token expired, email error) gets surfaced on the dashboard rather than only living in a server log.

## New dependencies (local app only)

| Package | Purpose | Phase |
|---|---|---|
| `technicalindicators` | RSI/MACD calculation (shared by trade-idea reports and confluence alerts) | 2 |
| `node-cron` | Scheduled report generation | 3 |
| `nodemailer` | Sending the email report via Gmail SMTP | 3 |

All pure JavaScript — no native build step, unlike `better-sqlite3` which the app already depends on. Note: geopolitical catalyst scanning and market-seasonality reference data need **no new dependency or API key** — they reuse the Perplexity key/integration already present in `local/.env.example`, and a static JS reference table respectively.

## New environment variables (`local/.env`)

```
FINNHUB_API_KEY=              # Phase 1 — sector classification (may reuse your spy-dashboard key)
TRADE_IDEA_CRON_ENABLED=      # Phase 3 — on/off switch for scheduling
TRADE_IDEA_CRON=              # Phase 3 — cron expression, e.g. "0 8 * * 1-5"
TRADE_IDEA_TICKERS=           # Phase 3 — optional manual watchlist override
GMAIL_USER=                   # Phase 3 — sending Gmail address
GMAIL_APP_PASSWORD=           # Phase 3 — Gmail App Password
TRADE_IDEA_EMAIL_TO=          # Phase 3 — recipient address
```

## Open questions for you

1. **Watchlist for Phase 2** — only tickers you've actually traded before (plus SPY), or do you want to manually add tickers you're watching but haven't traded yet? (This also becomes the confluence-alert watchlist in the Proactive Scout tab, managed the same way.)
2. **Report cadence** — daily on market days, weekly, or something else? Separately, do you want real-time confluence alert emails at all, or dashboard-only alerts with email reserved for the daily summary?
3. **Sequencing** — ship and use Phase 1/Performance Coach for a while before starting Phase 2/Proactive Scout, or build straight through?
4. **spy-dashboard reuse** — fine to hard-code the VIX-sizing/day-of-week/earnings-blackout rules I found there into the new generator, or do you want those to stay editable/configurable in case your playbook has changed since you built that dashboard?
5. **Time-of-day backfill** — worth a one-time re-sync attempt to backfill timestamps on already-synced trades (limited by how far back Schwab's transaction API will actually return data), or just start capturing it going forward and treat time-of-day analysis as "data from today onward only"?
6. **R-multiple vs. profit factor** — okay to substitute "profit factor by year" for the originally-requested "R-multiple by year" (see Phase 1 leak-analysis section) since R-multiple doesn't map cleanly onto an options premium-selling book, or do you have a specific per-trade "R" definition (e.g. max defined risk on the trade) you want used instead?

## Verification plan

- All changes checked with `node --check` and manual `curl` calls against the new `local/server.js` routes; you click through `local/local-dashboard.html` yourself to confirm (no local browser automation on my end, per how we've worked so far).
- Nothing to verify on the GitHub Pages site — it isn't touched by this plan. Any commit/push for this work stays scoped to files under `local/` only.
- Before Phase 3 (scheduling/email) is turned on: a manual review comparing a few generated reports against the raw data digest, to confirm the LLM isn't drifting from the real numbers.
