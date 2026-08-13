# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Money Bags Tracker" (repo `ossaenz/os_trades`) — a client-side options/stock trade tracker (P&L, positions,
wash sales, journal, tax reports). It's a **static, no-build, no-bundler** single-page app: plain HTML + global
`<script>` tags, no npm/webpack/vite anywhere in the main app. There is no `package.json` at the repo root.

There's a second, optional piece under `local/`: a Node/Express "local companion server" that syncs real
brokerage (Schwab) transactions and adds an Ollama-backed AI chat layer on top of the same data.

## Running it

- **Main app (static)**: `python3 server.py [port]` from the repo root (default port 8080). This isn't a generic
  static server — it sets `Cross-Origin-Opener-Policy: same-origin-allow-popups`, which is required for the
  Google Identity Services OAuth popup to work; a plain `python3 -m http.server` will break Google sign-in.
- **Local companion server** (`local/`): `cd local && npm install`, copy `.env.example` → `.env` (Schwab API
  keys, Ollama host/model, optional Perplexity key for web search), then `node server.js` or
  `docker compose up` (see `local/docker-compose.yml` / `local/Dockerfile`). It serves the new dashboard at `/`
  and a cloned copy of the main webapp at `/app` (built by copying `index.html`, `js/`, `css/` into the
  container — see Dockerfile). Requires `better-sqlite3` (native module, needs python3/make/g++ to build).
- No test suite and no lint config exist in this repo.

## Config and secrets

- `config.json` (repo root, gitignored) holds the Google OAuth `client_id` — copy the shape shown in
  `README.md`. Client IDs are not secret; never commit a client *secret*.
- `local/.env` (gitignored) holds `SCHWAB_CLIENT_ID` / `SCHWAB_CLIENT_SECRET`, `OLLAMA_HOST`, `CHAT_MODEL`,
  `EMBED_MODEL`, `PERPLEXITY_API_KEY`, `OLLAMA_API_KEY` — see `local/.env.example` for the full list.
  `local/data/`, `local/certs/`, and the Schwab token/hash JSON files are also gitignored — treat anything
  under `local/data` as runtime state, not source.
- If a secret is ever committed, rotate it and scrub history — see `README_SECURITY.md`.

## Architecture — main app

Everything runs in the browser against a single in-memory `db` object
(`{ transactions, importBatches, journalEntries, version }`), loaded via `js/storage.js`. There is no backend
API for the main app; persistence is local-file (File System Access API) or Google Drive `appDataFolder`
(`js/storage.js`), never `localStorage` for trade data (only UI/backend-location metadata goes there — see
`README.md`).

Script load order in `index.html` matters because everything is global (no modules, no imports):
`storage.js` → `parsing.js` → `engine.js` → `analytics.js` → `charts.js` → per-view scripts
(`js/views/*.js`) → `global-filter.js` → `main.js`. `main.js` is the router: `showView(id)` swaps the active
`.view` and calls that view's `render*()` function; `refreshAll()` re-renders everything and is the thing to
call after any mutation to `db`.

- `js/parsing.js` — turns broker CSV exports (Schwab format) into transaction rows.
- `js/engine.js` (`buildPositions`) — the core position/lot engine: sorts transactions (opens before closes on
  the same date via `ACTION_ORDER`), tracks open option/stock lots per symbol, and produces closed trades with
  fee attribution. Almost every view derives its numbers from this function's output, not from raw
  transactions directly.
- `js/analytics.js` — P&L/performance aggregation on top of `buildPositions()` output.
- `js/views/*.js` — one file per tab (dashboard, positions, trades, journal, wash sales, advanced wash sales,
  reports, audit, import). Each exposes a `render<View>()` called from `main.js`.
- `js/global-filter.js` — the shared year/account filter that most views respect.

## Architecture — local companion (`local/`)

Single `server.js` (Express) is the whole backend: Schwab OAuth (`/auth`, `/api/auth/schwab/callback`),
transaction sync (`local/sync-schwab.js`, triggered via `POST /api/sync`), persistence into SQLite
(`local/data/trades.db` via `better-sqlite3`), a dashboard API (`/api/dashboard`, `/api/positions`,
`/api/journal/*`), and an AI layer (`/api/ai/chat`, `/api/rag/*`) that talks to a local Ollama instance plus
`local/rag.js` for retrieval and optional Perplexity web search. It also reverse-proxies/serves a copy of the
main static app at `/app` with `local/local-enhance.js` injected on top (see route comment block at the top of
`server.js` for the full route list before adding new ones).

## MCP servers

- `tradingview` — project-scoped MCP server (registered via `claude mcp add`, lives in
  `~/.claude.json` under this project's entry, not committed/not repo config). Runs
  `uvx --from tradingview-mcp-server tradingview-mcp` (stdio). Gives 30+ tools: Yahoo-Finance-backed
  quotes/screeners, technical indicators, candlestick pattern detection, and strategy backtesting
  (RSI/MACD/Bollinger/EMA-cross/Supertrend/etc). No API key required for core functionality; only its
  news/sentiment tools need an optional `MARKETAUX_API_TOKEN` (not set). This is a standalone data
  source — it is **not** wired into `local/tradeIdeas.js`'s digest pipeline, which pulls its own
  quotes/chains/candles directly from Schwab.

## Repo-specific notes

- `.specify/` / `.github/agents,prompts` are spec-kit scaffolding; `.specify/memory/constitution.md` is still
  the unfilled template (no project-specific rules recorded there yet).
- Stray root files like `index.html.bak-20260614-134041` and `index.html_Do_not_delete` are manual backups the
  user made, not build artifacts — don't delete them without asking.
