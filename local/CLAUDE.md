# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope of this file

This file covers `local/` only — the Node/Express "local companion server" (Schwab sync + SQLite + Ollama-backed
AI layer called **Plutus**). It assumes you've already read the repo-root `CLAUDE.md`, which covers the main
static app and the split between the two. Don't repeat that file's "Running it" / "Config and secrets" sections
here — this file goes one level deeper into `local/`'s own architecture.

## Commands

- `cd local && npm install` — install deps (`better-sqlite3` is a native module; the Dockerfile installs
  `python3 make g++` to compile it — you need the same locally if not using Docker).
- `node server.js` — run directly. Serves HTTPS on port **8080** (self-signed cert in `local/certs/`, generated
  on demand) because Schwab's OAuth redirect URI requires HTTPS (`REDIRECT_URI` is hardcoded to
  `https://127.0.0.1:8080/api/auth/schwab/callback`).
- `docker compose up` — same server in a container (`local/docker-compose.yml` / `local/Dockerfile`); the
  Dockerfile copies the main app's `index.html`/`js/`/`css/`/`logos/` into `./webapp/` at build time to serve the
  `/app` clone — those are a snapshot, not a live mount, so a Docker rebuild is needed to pick up main-app changes.
- `node test-schwab-auth.js` (or `npm run test-auth`) — standalone Schwab OAuth/token sanity check.
- No lint config, no automated test suite (`test-transactions.js`/`setup-check.js` are manual scratch/verification
  scripts, not a test runner).
- `local/data/trades.db` (SQLite, gitignored) is the source of truth once synced — treat it as runtime state.

## Architecture

Single-file backend (`server.js`, ~3700 lines) plus a handful of pure-computation modules it `require()`s. There's
no router/controller split — every route is a top-level `app.get/post/delete(...)` in `server.js`, grouped by the
route-comment block at the top of the file (read that block before adding a route — it's the actual route
inventory, more current than this doc will stay).

### Data layer

`better-sqlite3` against `local/data/trades.db`, schema created inline in `server.js` on boot (`db.exec(...)`
near the top) plus two more tables created in `rag.js`'s `initRagTables(db)`. Tables, and what owns them:

| Table | Written by | Purpose |
|---|---|---|
| `trades` | Schwab sync (`sync-schwab.js`) / CSV import | The one source of truth for P&L. One row per fill/leg — `symbol` is the option contract string (`"PLTR 06/19/2026 130.00 P"`) or bare ticker for equity; `underlying` is always the bare ticker; `action` is Schwab's action string (`Sell to Open`, `Buy to Close`, `Expired`, `Assigned`, `Exercised`, `Buy`, `Sell`, ...); `amount` is signed net cash (negative = debit). |
| `sector_cache` | Finnhub lookups | Ticker → sector/industry, refreshed at most every 30 days per symbol. |
| `risk_snapshots` | Performance Coach polling | Daily margin/leverage ratio history. |
| `trade_idea_reports` | Proactive Scout | Audit trail for generated trade-idea reports — `digest_json` is the exact data blob the LLM was given, kept specifically so report quality can be debugged against its inputs. |
| `scout_watchlist`, `confluence_alerts` | Proactive Scout | Tickers being monitored + fired RSI/MACD/volume-confluence alerts. |
| `rag_docs` (`rag.js`) | RAG indexing (`/api/rag/index`) | Embedded chunks (trades + journal entries) for semantic search, `UNIQUE(source, ref_id) ON CONFLICT REPLACE` so re-indexing is idempotent. |
| `journal_entries` (`rag.js`) | `/api/journal`, `save_journal_entry` AI tool | Local journal, separate from and in addition to the main app's own journal storage (`js/views/journal.js` — that one persists to the user's chosen backend, this one is local-server-only). |

"Closed position" is **not** a stored concept — every module that needs it re-derives it by grouping `trades` by
`symbol` and checking whether the action set contains both an opening and closing action (or is all `Expired`).
That grouping logic is currently duplicated (`computeDashboard()` in `server.js`, `_closedPositions()` in
`tradingInsights.js`) rather than shared — be aware of both call sites if you change the definition of "closed."

### Analytics modules

Each is a pure `(db, ...args) → plain object` module with no Express/HTTP knowledge, called from route handlers:

- `tradingInsights.js` — win rate by journal-tagged setup, holding-period P&L buckets, deterministic (non-LLM)
  plain-English "leak" insights (worst setup, worst day-of-week, hold-time effect).
- `riskMetrics.js` — margin/leverage ratio computation + history (backs the risk-thermometer UI).
- `portfolioRisk.js` — net Greeks/expiration-assignment calendar and sector/position concentration warnings.
- `tradeIdeas.js` — builds the ticker digest + prompt for the Proactive Scout's one-shot trade-idea LLM report.
- `indicatorEngine.js` — RSI/MACD/volume-spike confluence detection for the Scout's watchlist scanner.
- `indicators.js` / `sectors.js` — lower-level technical-indicator math and Finnhub sector lookups these build on.
- `rag.js` — SQLite-backed RAG: table setup, embedding + indexing, semantic `search()`, `buildContext()` for
  prompt assembly.

`tradingInsights.js`'s functions are also called directly from `generate_leak_insights` (see below) in addition
to the `/api/analytics/insights` REST endpoint the dashboard UI uses — same logic, two callers. If asked to
extend what Plutus (the chat AI) can compute, check whether the logic already exists here (or in
`plutusTools.js`) before writing it again inside `server.js`.

### Plutus — the AI chat layer (`POST /api/ai/chat`)

This is the most complex single route in the file (`server.js`, search for `app.post('/api/ai/chat'`). It talks
to a **local Ollama instance** (not a hosted API) using Ollama's native OpenAI-style `tools` function-calling
format. Model defaults to `0xroyce/plutus` (`CHAT_MODEL` env var) — a fine-tuned Ollama model, distinct from the
generic embedding model (`EMBED_MODEL`, auto-detected from whatever's pulled locally if not set).

Request flow, in order:

1. **Always-on context assembly** — `computeDashboard()` stats, `buildTradingStyleProfile()`, and a live Schwab
   account snapshot are stuffed into the system prompt unconditionally (wrapped in try/catch — each degrades to
   a "unavailable" placeholder string rather than failing the request).
2. **Market-intent detection** — a regex (`MARKET_INTENT`) decides whether the message is asking about live
   market/news info. If so, RAG is skipped and a web search is pre-fetched instead, specifically so the model
   can't mistake the trader's own trade history for market news (there's an explicit system-prompt rule against
   this — it's a recurring failure mode worth preserving the guard for).
3. **RAG retrieval** (non-market queries) — pinned `summary`-source docs are always included, plus up to 4
   semantic hits from `rag.search()`, deduped against the pinned set.
4. **System prompt** — defines Plutus's persona (dual-mandate trader: "Strategic Owner" wheel/dividend book vs.
   "Tactical Trader" swing book), a strict data-provenance policy (account history → tools only, never
   fabricated; market news → only from live web results, never repackaged trade data), the full trades-table
   schema with example SQL, a tool reference table, several named multi-step workflows (trade suggestion, trade
   post-mortem, hybrid performance review, tax/deep-analytics), tax rules (wash sale, cost basis, ESPP, options
   taxation — cites the specific IRC sections and IRS FAQ), and the chat UI's ` ```chart ` code-block spec for
   inline Chart.js rendering.
5. **Deterministic short-circuits** — `isStrategyRequest`, `isShortExposureRequest`, `isDeepAnalyticsRequest`
   pattern-match the message and, if matched, bypass the LLM tool-calling loop entirely in favor of a fixed
   Node-side data → template pipeline (`generateActionableStrategyFallback`, `generateShortExposureReply`,
   `generateDeepAnalyticsReply`). This exists because the model doesn't reliably choose the right tool chain on
   its own for these intents — don't remove a short-circuit without confirming the underlying tool-choice
   reliability problem is actually fixed.
6. **Tool-calling loop** (only runs if no short-circuit fired) — up to 5 rounds: POST to
   `${OLLAMA_HOST}/api/chat` with `tools`, check `assistantMsg.tool_calls`, dispatch each call by name to its
   Node implementation, push `{role: 'tool', content: <string>}` back onto `messages`, loop. Breaks on the first
   response with no `tool_calls`.

Currently-wired tools (name → what it calls): `query_trades` (read-only ad-hoc SQL against `trades`, SELECT-only
with a keyword blocklist — the general escape hatch), `save_journal_entry`, `get_account_snapshot` /
`get_quote` / `get_options_chain` / `get_price_history` / `get_market_movers` / `get_market_hours` (all live
Schwab data), `get_advanced_analytics` (wash sales / tax / fee-drag / projections), `web_search` /
`get_market_news` (only offered to the model at all when `PERPLEXITY_API_KEY` or `OLLAMA_API_KEY` is set), and
four structured compute tools backed by `plutusTools.js` — `get_trades` (filtered raw fill lookup), `get_positions`,
`compute_metrics` (win rate / profit factor / expectancy / max drawdown / avg hold time / fee drag / roll_count /
Sharpe·Sortino), and `generate_leak_insights` (server.js-local — combines `tradingInsights.js` output with a
`computeAdvancedAnalytics()` wash-sale figure into structured `{leak_type, estimated_pnl_impact, confidence,
evidence}` records).

Most tool results are **plain formatted text** (tables/prose) that the model reads as strings — that's still true
for the original 7 Schwab/search/analytics tools above. The four `plutusTools.js`-backed tools are the exception:
they return `JSON.stringify({ok, data|reason})`, specifically so derived metrics (win rate, drawdown, profit
factor, expectancy) are computed once in Node and read as precise fields rather than summed/eyeballed by the
model from `query_trades` output.

`plutusTools.js` is a thin SQLite data-access layer only — the actual PnL/position logic lives in
**`positionEngine.js`**, a pure `(trade rows) -> plain objects` module with no DB/Express knowledge (deliberately
decoupled so it's unit-testable and portable). It has two engines, because equities and options need genuinely
different accounting:
- **Options** (`buildOptionChains`): contracts grouped by exact symbol, closed/open by action set, same as
  before — but now **roll-aware**. A same-day close-and-reopen on the same underlying and same right (call/put)
  — e.g. buy-to-close one contract and sell-to-open a different one, same day — is linked into a single "chain"
  and treated as ONE logical trade: aggregate `net_pnl`/`hold_days` span every leg, while each leg's own
  contribution stays inspectable via `chain.legs[]`. Chains of length 1 are the ordinary (non-rolled) case, so
  callers don't need a separate code path. Linking is same-day-only, matched by (underlying, date, right,
  complementary action) — confirmed against this account's real data before writing it (see git history on
  `positionEngine.js` if the heuristic needs revisiting).
- **Equities** (`buildEquityLots`): FIFO buy/sell lot matching (Buy/Sell actions only — splits, transfers,
  dividends, journaled shares are explicitly out of scope, not silently mishandled).

Both emit the same position shape, so `get_positions`/`compute_metrics` don't need per-asset-class branches;
`asset_type` defaults to `OPTION` (not `ALL`) to match Plutus's options-centric framing in the system prompt —
pass `EQUITY` or `ALL` explicitly to include equity lots.

**Two data-quality flags exist because real synced data has real gaps** — found by running these tools against
the actual `trades.db`, not hypothesized: (1) `has_incomplete_pricing` — roughly 78% of historical OPTION rows
have `price=0 AND amount=0` (concentrated in `Sell to Open`/`Buy to Close`, which should essentially never be
genuinely $0), evidently from an old bulk import gap, not a live bug (current Schwab syncs price correctly — spot-
checked against `schwab-auto-import.csv`); (2) `past_expiry_unclosed` — several OPTION contracts from 2022-2024
still show `status: open` despite their expiry having long passed, meaning the DB has no closing/expiration row
for them. Neither is something this app's tool layer should silently paper over — both are surfaced as explicit
fields so Plutus reports "data gap," never "breakeven trade" or "live open exposure." `get_trades`/`get_positions`
also carry a `note` field when `truncated: true`, telling the model explicitly not to sum a partial page into a
total (this was verified to matter in practice — see below).

**Verified against the real `trades.db` with `qwen2.5:3b`** (a small local model, not this app's configured
`CHAT_MODEL`) end-to-end through the actual Ollama tool-calling loop: single-scope aggregate questions (e.g. "win
rate on TSLA") work correctly. Multi-position synthesis is where a 3B model breaks down even with correct tool
output — it duplicated single legs into fabricated "Leg 2" entries, and even after the `note` field was added, it
still produced a fabricated headline P&L number from a truncated position list instead of calling
`compute_metrics`. The tool/data layer was verified correct throughout (ground-truth-checked against direct
`plutusTools.js` calls); the failure mode is model capability at small parameter counts, not tool design. Not an
active production concern — `local/.env`'s actual `CHAT_MODEL` is `qwen3.6:latest`, a much larger model — but
worth knowing before pointing a small/cheap model at this chat endpoint. There's still no arithmetic tool —
multi-step math the model needs (position sizing, breakeven, R-multiples) is done by the model itself with no
guardrail; a `basic_calculator` tool would be the next logical addition if that becomes a problem in practice.

### Two other Ollama-backed flows, same conventions

- `POST /api/trade-ideas/generate` (`tradeIdeas.js`) — one-shot report generation (no multi-turn tool loop): builds
  a data digest across a ticker list, sends one prompt, stores the result + the digest it was given in
  `trade_idea_reports` for later audit.
- `POST /api/scout/scan` — deterministic (non-LLM) confluence scan over the watchlist using `indicatorEngine.js`;
  fires rows into `confluence_alerts` when signal thresholds are met. No model call at all — pure computation.

### Serving the main app (`/app`)

`local/local-enhance.js` is injected into the cloned `index.html` to add a Schwab-connected panel on top of the
otherwise-unmodified main app. The clone lives under `webapp/` (built by the Dockerfile, or symlinked/copied
manually for non-Docker dev) — it is a **snapshot**, never the live repo-root files, so changes to the main app's
`index.html`/`js/`/`css/` don't appear at `/app` until the clone step re-runs.
