/**
 * TG-Capital Local Server
 * Serves a new professional dashboard at / and the cloned trading app at /app.
 * Schwab sync data is persisted to SQLite for dashboard metrics and Ollama AI context.
 *
 * Routes:
 *   GET  /                          → new professional dashboard
 *   GET  /app                       → cloned webapp (index.html with Schwab panel injected)
 *   GET  /local-enhance.js          → enhancement script for /app
 *   GET  /auth                      → start Schwab OAuth
 *   GET  /api/auth/schwab/callback  → OAuth callback
 *   GET  /api/status                → sync status JSON
 *   POST /api/sync                  → trigger Schwab transaction pull
 *   GET  /api/csv-text              → raw CSV for in-app import
 *   GET  /api/dashboard             → dashboard metrics from SQLite
 *   GET  /api/positions             → live positions from Schwab API
 *   GET  /api/recent                → recent rows from last CSV
 *   GET  /api/ai/models             → available Ollama models
 *   POST /api/ai/chat               → Ollama AI chat with trade context
 *   GET  /download                  → download CSV
 *
 *   -- Performance Coach tab (Phase 1) --
 *   GET  /api/analytics/seasonality  → year-over-year + day-of-week/month/time-of-day P&L
 *   GET  /api/analytics/sector       → P&L grouped by sector (Finnhub-classified)
 *   GET  /api/analytics/insights     → win rate by setup, holding-period breakdown, leak insights
 *   GET  /api/analytics/risk         → margin/leverage ratio + risk-thermometer history
 *   GET  /api/analytics/portfolio-risk → net Greeks, expiration/assignment calendar, concentration warnings
 *   GET  /api/analytics/benchmark    → your realized P&L vs. SPY buy-and-hold
 *
 *   -- Proactive Scout tab (Phase 2) --
 *   POST /api/trade-ideas/generate   → one-shot Ollama trade-idea report across a ticker digest
 *   GET  /api/trade-ideas            → list past reports
 *   GET  /api/trade-ideas/:id        → fetch one report + its full data digest
 *   GET  /api/scout/watchlist        → confluence-alert watchlist
 *   POST /api/scout/watchlist        → add a ticker to the watchlist
 *   DELETE /api/scout/watchlist/:ticker → remove a ticker from the watchlist
 *   GET  /api/scout/edgar/new-tickers → tickers that newly filed Form 8-A12B on EDGAR (?days=7)
 *   POST /api/scout/scan             → scan the watchlist for RSI/MACD/volume confluence, fire alerts
 *   GET  /api/scout/alerts           → list fired confluence alerts
 *   POST /api/scout/alerts/:id/ack   → acknowledge an alert
 */

require('dotenv').config();
const express        = require('express');
const https          = require('https');
// Node 22 built-in fetch — node-fetch v2 throws "Premature close" on Ollama responses
const fs             = require('fs');
const path           = require('path');
const rag            = require('./rag.js');
const sectors        = require('./sectors.js');
const news           = require('./news.js');
const tradingInsights = require('./tradingInsights.js');
const riskMetrics    = require('./riskMetrics.js');
const portfolioRisk  = require('./portfolioRisk.js');
const tradeIdeas     = require('./tradeIdeas.js');
const indicatorEngine = require('./indicatorEngine.js');
const indicators     = require('./indicators.js');
const plutusTools    = require('./plutusTools.js');
const lmSentiment    = require('./lmSentiment.js');
const dilutionLexicon = require('./dilutionLexicon.js');
const crypto         = require('crypto');
const { execSync }   = require('child_process');
const Database       = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.SCHWAB_CLIENT_ID;
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET;
const OLLAMA_HOST   = process.env.OLLAMA_HOST   || 'http://host.docker.internal:11434';
const CHAT_MODEL    = process.env.CHAT_MODEL    || '0xroyce/plutus';
// Retried once, automatically, whenever the primary model errors or crashes
// mid-request (confirmed via the Aug 2026 model bake-off: qwen3.8:27b — the
// faster, now-default model — hard-failed with HTTP 500 on 2 of 10 real
// filings, both dense foreign-issuer 20-Fs). qwen3-vl-32b-tgcapital never
// failed a single request across either bake-off round, which is why it's the
// fallback rather than the default despite being slower. See ollamaChatWithFallback.
const CHAT_MODEL_FALLBACK = process.env.CHAT_MODEL_FALLBACK || 'qwen3-vl-32b-tgcapital';
// Lower temperature = more consistency, less hedging/fabrication on numbers that
// should just be read verbatim from a tool result — see Plutus.Modelfile's own
// PARAMETER temperature comment for the same reasoning.
const CHAT_TEMPERATURE = Math.max(0, Math.min(1, Number(process.env.CHAT_TEMPERATURE ?? 0.25)));
const OLLAMA_CHAT_TIMEOUT_MS = Math.max(30000, Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || 300000));
const OLLAMA_API_KEY    = process.env.OLLAMA_API_KEY    || '';
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const FINNHUB_API_KEY    = process.env.FINNHUB_API_KEY    || '';
const SCOUT_INGEST_TOKEN = process.env.SCOUT_INGEST_TOKEN || '';
// Small-footprint local model for the Contradiction Engine's one-shot
// SEC-text-vs-sentiment comparison — this doesn't need tool-calling (both
// texts are fetched and handed to it directly), so a small model is fine;
// gemma4:e2b is Google's edge/mobile-optimized architecture. Configurable
// since "best small-footprint model for this" is a moving target.
let   CONTRADICTION_MODEL = process.env.CONTRADICTION_MODEL || 'gemma4:e2b';
const CONTRADICTION_MODEL_FALLBACK = process.env.CONTRADICTION_MODEL_FALLBACK || 'qwen3-vl-32b-tgcapital';
// Cheap triage model for 8-K analysis on the broader ticker-universe firehose
// (thousands of filings/day, vs. dozens for the hand-curated watchlist) — a
// 3B model keeps that volume affordable. Watchlist tickers still get the full
// CONTRADICTION_MODEL treatment via analyze8KWithLlama, unchanged.
const EIGHT_K_TRIAGE_MODEL = process.env.EIGHT_K_TRIAGE_MODEL || 'qwen2.5:3b';
// Preferred embedding models in priority order
const EMBED_PREF    = ['nomic-embed-text', 'mxbai-embed-large', 'qwen3-embedding', 'embeddinggemma'];
let   EMBED_MODEL   = process.env.EMBED_MODEL  || 'nomic-embed-text';

async function detectEmbedModel() {
  if (process.env.EMBED_MODEL) return; // user explicitly set it
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const { models = [] } = await r.json();
    const names = models.map(m => m.name);
    for (const pref of EMBED_PREF) {
      const match = names.find(n => n.startsWith(pref));
      if (match) { EMBED_MODEL = match; console.log(`🔍  Embedding model auto-selected: ${EMBED_MODEL}`); return; }
    }
    // Fallback: any model with "embed" in the name
    const anyEmbed = names.find(n => n.toLowerCase().includes('embed'));
    if (anyEmbed) { EMBED_MODEL = anyEmbed; console.log(`🔍  Embedding model (fallback): ${EMBED_MODEL}`); }
  } catch {}
}
detectEmbedModel();

// CONTRADICTION_MODEL fallback (only runs when the env var is unset): prefer a
// Qwen model under 8B params over the hardcoded gemma4:e2b default — Qwen2.5-7B-Instruct
// is already proven in this app's tool-calling loop (see DerivativeStrategist.Modelfile)
// and general text/JSON-mode quality at that size tends to beat Gemma's edge-tuned line.
// Skips vision/embedding/reranker Qwen variants (wrong tool for JSON-mode text analysis).
const CONTRADICTION_PREF = ['qwen2.5:7b-instruct'];
async function detectContradictionModel() {
  if (process.env.CONTRADICTION_MODEL) return; // user explicitly set it
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const { models = [] } = await r.json();
    for (const pref of CONTRADICTION_PREF) {
      if (models.some(m => m.name === pref)) {
        CONTRADICTION_MODEL = pref;
        console.log(`🔍  Contradiction model auto-selected: ${CONTRADICTION_MODEL}`);
        return;
      }
    }
    const skip = /vl|embed|rerank/i;
    const candidates = models
      .filter(m => /qwen/i.test(m.name) && !skip.test(m.details?.family || '') && !skip.test(m.name))
      .map(m => ({ name: m.name, size: parseFloat(m.details?.parameter_size || '') }))
      .filter(m => Number.isFinite(m.size) && m.size < 8)
      .sort((a, b) => b.size - a.size); // largest-under-8B first
    if (candidates.length) {
      CONTRADICTION_MODEL = candidates[0].name;
      console.log(`🔍  Contradiction model auto-selected (Qwen <8B): ${CONTRADICTION_MODEL}`);
    }
  } catch {}
}
detectContradictionModel();

// Every /api/chat call in this file goes through here so a primary-model crash
// (HTTP error, timeout, malformed response) automatically retries once against
// the configured fallback instead of failing the whole request. Relies on
// OLLAMA_MAX_LOADED_MODELS=1 (see local/README or ollama.service override) so
// Ollama itself evicts the primary from VRAM before loading the fallback —
// that's what actually stops two large models fighting over VRAM and crashing
// the host, not anything this function does directly.
// `validate`, if given, runs INSIDE the retry boundary — a response that comes
// back HTTP 200 but with malformed/truncated JSON (confirmed live: PLUG's
// Truth Check failed 7 times in a row with "Unterminated string in JSON" /
// "Unexpected end of JSON input" from the primary model, and never once
// retried on the fallback, because the original version of this function only
// caught fetch-level failures — JSON.parse happened after it had already
// returned successfully) needs to count as a failure too, not just a non-OK
// HTTP status. validate's return value is threaded back as `parsed` so callers
// don't have to parse a second time.
async function ollamaChatWithFallback(primaryModel, fallbackModel, bodyWithoutModel, timeoutMs, validate) {
  const attempt = async (model) => {
    const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bodyWithoutModel, model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Ollama error (${model}): ${await r.text()}`);
    const data = await r.json();
    const parsed = validate ? validate(data) : undefined;
    return { data, parsed, modelUsed: model };
  };
  try {
    return await attempt(primaryModel);
  } catch (err) {
    if (!fallbackModel || fallbackModel === primaryModel) throw err;
    console.warn(`⚠️  ${primaryModel} failed (${err.message.slice(0, 200)}) — retrying with fallback ${fallbackModel}`);
    return await attempt(fallbackModel);
  }
}

const PORT          = 8080;
const REDIRECT_URI  = `https://127.0.0.1:${PORT}/api/auth/schwab/callback`;
const AUTH_URL      = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL     = 'https://api.schwabapi.com/v1/oauth/token';
const API_BASE      = 'https://api.schwabapi.com/trader/v1';
const MARKET_BASE   = 'https://api.schwabapi.com/marketdata/v1';

// Gmail alerts — server-side OAuth (authorization-code + refresh token), separate flow
// from the main static app's browser-only Google Identity Services/Drive integration
// (js/storage.js) — that one has no server component and can't send email autonomously
// when a material 8-K fires with no user present. Reuses the same GCP OAuth Client ID
// as that integration if GOOGLE_CLIENT_ID is set to it; needs its own Client Secret
// (server-side flows require one, the browser-only Drive flow never did) and the
// gmail.send scope added to that OAuth client in Google Cloud Console.
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GMAIL_SEND_TO        = process.env.GMAIL_SEND_TO || '';
const GMAIL_REDIRECT_URI   = `https://127.0.0.1:${PORT}/api/auth/gmail/callback`;
const GOOGLE_AUTH_URL      = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPE          = 'https://www.googleapis.com/auth/gmail.send';

const DATA_DIR    = path.join(__dirname, 'data');
const CERTS_DIR   = path.join(__dirname, 'certs');
const WEBAPP_DIR  = path.join(__dirname, 'webapp');
const TOKEN_FILE  = path.join(DATA_DIR, 'tokens.json');
const GMAIL_TOKEN_FILE = path.join(DATA_DIR, 'gmail-tokens.json');
const HASH_FILE   = path.join(DATA_DIR, 'account-hash.json');
const CSV_FILE    = path.join(DATA_DIR, 'schwab-import.csv');
const STATUS_FILE = path.join(DATA_DIR, 'sync-status.json');
const DB_FILE     = path.join(DATA_DIR, 'trades.db');
// Scout Ingest storage — lives inside DATA_DIR (the ./data volume mount) so
// ingested records survive `docker compose up --build`, unlike anything
// stored under the app's own source tree.
const SCOUT_INGEST_RAW_DIR   = path.join(DATA_DIR, 'scout-ingest', 'raw');
const SCOUT_INGEST_LOG_FILE  = path.join(DATA_DIR, 'scout-ingest', 'logs', 'ingest.log');
const SCOUT_INGEST_LAST_ID   = path.join(DATA_DIR, 'scout-ingest', 'state', 'last_ingest_id.txt');

[DATA_DIR, CERTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
[SCOUT_INGEST_RAW_DIR, path.dirname(SCOUT_INGEST_LOG_FILE), path.dirname(SCOUT_INGEST_LAST_ID)]
  .forEach(d => fs.mkdirSync(d, { recursive: true }));

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// ── SQLite ────────────────────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date_csv   TEXT NOT NULL,
    date_iso   TEXT NOT NULL,
    action     TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    underlying TEXT,
    asset_type TEXT,
    description TEXT DEFAULT '',
    quantity   REAL DEFAULT 0,
    price      REAL DEFAULT 0,
    fees       REAL DEFAULT 0,
    amount     REAL DEFAULT 0,
    synced_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(date_csv, action, symbol, quantity)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_date       ON trades(date_iso);
  CREATE INDEX IF NOT EXISTS idx_underlying ON trades(underlying);
  CREATE INDEX IF NOT EXISTS idx_action     ON trades(action);
`);
// Migration: capture time-of-day going forward (Schwab's transaction API returns a
// full timestamp; only the date portion was stored previously). Existing rows keep
// time_iso = NULL — only trades synced/imported after this migration will have it.
try { db.exec(`ALTER TABLE trades ADD COLUMN time_iso TEXT`); } catch {}

// ── Performance Coach: sector classification cache (Finnhub) ─────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sector_cache (
    symbol     TEXT PRIMARY KEY,
    sector     TEXT,
    industry   TEXT,
    source     TEXT DEFAULT 'finnhub',
    fetched_at TEXT DEFAULT (datetime('now')),
    stale      INTEGER DEFAULT 0
  ) STRICT;
`);

// ── Performance Coach: risk-thermometer history (margin/leverage over time) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS risk_snapshots (
    date_iso       TEXT PRIMARY KEY,
    ratio          REAL,
    equity         REAL,
    buying_power   REAL,
    margin_balance REAL
  ) STRICT;
`);

// ── Proactive Scout: generated trade-idea reports (audit trail — digest_json
//    lets you see exactly what data the LLM was given, not just what it wrote) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS trade_idea_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_at TEXT DEFAULT (datetime('now')),
    trigger      TEXT DEFAULT 'manual',
    tickers      TEXT,
    digest_json  TEXT,
    report_md    TEXT,
    emailed      INTEGER DEFAULT 0,
    email_error  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tir_generated ON trade_idea_reports(generated_at);
`);

// ── Proactive Scout: confluence-alert watchlist + fired alerts ───────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_watchlist (
    ticker   TEXT PRIMARY KEY,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS confluence_alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker       TEXT,
    direction    TEXT,
    rsi14        REAL,
    macd_status  TEXT,
    volume_ratio REAL,
    signals_json TEXT,
    fired_at     TEXT DEFAULT (datetime('now')),
    acknowledged INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ca_fired ON confluence_alerts(fired_at);
`);
// confluence_alerts only ever gets a row when a signal actually fires — a
// scan that finds nothing leaves no trace, so the UI can't tell "never
// scanned" from "scanned, nothing fired" without this. Set on every scan
// regardless of outcome.
try { db.exec(`ALTER TABLE scout_watchlist ADD COLUMN last_scanned_at TEXT`); } catch {}

// ── Multi-user groundwork (schema only — not enforced anywhere yet) ──────────
// This app is single-user today: one Schwab account, one GMAIL_SEND_TO, no
// session/auth layer. This table plus the user_id columns below are additive
// migration only — no existing column is dropped or altered, and no existing
// row is touched (both ALTERs are on nullable columns, so every current row
// simply gets user_id = NULL). Nothing in server.js reads or enforces user_id
// yet; every route still operates account-wide exactly as before. Actually
// scoping data per-user (auth, session, filtering every query by user_id) is
// deliberately deferred to a later phase — this migration exists purely so
// that future work has a column to migrate into instead of a schema change
// happening at the same time as the auth logic itself.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT UNIQUE,
    display_name TEXT,
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
  );
`);
// try/catch, not IF NOT EXISTS (SQLite's ALTER TABLE ADD COLUMN has no such
// clause) — safe to run on every boot; a rerun against an already-migrated
// database just hits "duplicate column" and is silently skipped, same
// convention as every other additive column block in this file.
try { db.exec(`ALTER TABLE scout_watchlist ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch {}
try { db.exec(`ALTER TABLE confluence_alerts ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch {}

// ── Proactive Scout: extracted SEC filings (from scout-ingest raw JSON) ──────
// Flattened, queryable form of what /api/v1/ingest writes to disk for
// source='sec_edgar'/kind='filing_batch' payloads — this is the "Directory
// Watcher" step: extraction happens inline at ingest time (see
// extractSecFilingsFromRecord below), not via a separate polling process,
// since the ingest route is already the only writer to that directory.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_sec_filings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker            TEXT,
    accession_number  TEXT UNIQUE,
    entity_name       TEXT,
    form_type         TEXT,
    filed_at          TEXT,
    description       TEXT,
    filing_url        TEXT,
    ingest_id         TEXT,
    extracted_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ssf_ticker   ON scout_sec_filings(ticker);
  CREATE INDEX IF NOT EXISTS idx_ssf_filed_at ON scout_sec_filings(filed_at);
`);
// ── Ticker universe: every US, major-exchange-listed (no OTC) company —────────
// the broader net the 8-K firehose scans, separate from scout_watchlist (the
// small hand-curated list that still gets full-model analysis + immediate
// email alerts). Synced from SEC's own company_tickers_exchange.json, not
// re-derived per request — that file changes rarely (new listings/delistings),
// see syncTickerUniverse's staleness check.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_ticker_universe (
    cik       INTEGER PRIMARY KEY,
    ticker    TEXT UNIQUE,
    name      TEXT,
    exchange  TEXT,
    synced_at TEXT DEFAULT (datetime('now'))
  );
`);
// avg_volume/volume_synced_at added after the table already existed in
// running installs — ALTER, not part of the CREATE above, same convention as
// every other additive column block in this file (see scout_watchlist's
// last_scanned_at/user_id ALTERs).
try { db.exec(`ALTER TABLE scout_ticker_universe ADD COLUMN avg_volume INTEGER`); } catch {}
try { db.exec(`ALTER TABLE scout_ticker_universe ADD COLUMN volume_synced_at TEXT`); } catch {}
// Insider trading (Form 3/4/5, Section 16 filings) — a separate table, not additive
// columns on scout_sec_filings, because a single accession can report MULTIPLE
// transactions (one row each here) and the columns needed (owner identity, transaction
// code/shares/price) don't apply to any other filing type. UNIQUE spans the fields that
// actually distinguish two real transactions on the same filing, so re-fetching an
// already-known accession is a safe no-op rather than a duplicate insert.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_insider_filings (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker                  TEXT,
    cik                     TEXT,
    accession_number        TEXT,
    form_type               TEXT,
    filed_at                TEXT,
    period_of_report        TEXT,
    owner_name              TEXT,
    owner_is_officer        INTEGER,
    owner_is_director       INTEGER,
    owner_is_ten_pct_owner  INTEGER,
    owner_title             TEXT,
    transaction_date        TEXT,
    transaction_code        TEXT,
    transaction_code_label  TEXT,
    shares                  REAL,
    price_per_share         REAL,
    acquired_disposed_code  TEXT,
    shares_owned_following  REAL,
    is_derivative           INTEGER,
    filing_url              TEXT,
    fetched_at              TEXT DEFAULT (datetime('now')),
    UNIQUE(accession_number, transaction_date, transaction_code, shares, owner_name)
  );
  CREATE INDEX IF NOT EXISTS idx_sif_ticker   ON scout_insider_filings(ticker);
  CREATE INDEX IF NOT EXISTS idx_sif_filed_at ON scout_insider_filings(filed_at);
`);
// Finnhub company news — secondary/gap-fill source alongside SEC filings (primary
// event layer) and crawled web sentiment. UNIQUE(ticker, url) so re-fetching an
// already-known article is a safe no-op, matching the insider-filings pattern above.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_news (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker       TEXT,
    headline     TEXT,
    summary      TEXT,
    source       TEXT,
    url          TEXT,
    published_at TEXT,
    fetched_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(ticker, url)
  );
  CREATE INDEX IF NOT EXISTS idx_news_ticker ON scout_news(ticker);
`);
// "Should I trade/invest/pass on this ticker" — one synthesis LLM call combining
// tradeIdeas.js's financial/technical digest with Scout's SEC/insider/news/truth-
// check data (toolGetTruthCheck). digest_json is kept for the same audit reason
// trade_idea_reports.digest_json is: so a bad verdict can be debugged against
// exactly what the model was given, not re-derived from scratch later.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_verdicts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker       TEXT,
    verdict      TEXT,   -- 'trade' | 'invest' | 'pass'
    score        INTEGER,
    summary      TEXT,
    reasons_json TEXT,
    caution      TEXT,
    digest_json  TEXT,
    model_used   TEXT,
    generated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_verdicts_ticker ON scout_verdicts(ticker);
`);
// 8-K discovery: Llama material-event analysis columns, additive. One row per filing
// already exists in scout_sec_filings (accession_number UNIQUE) — no new table needed
// for a 1:1 relationship. cik is stored separately from filing_url since URLs are
// occasionally missing the leading-zero-padded form some downstream calls expect.
for (const col of [
  'cik TEXT',
  'llama_summary TEXT', 'llama_sentiment TEXT', 'llama_material_event INTEGER',
  'llama_key_items TEXT', 'llama_confidence REAL', 'llama_raw_response TEXT',
  'llama_analyzed_at TEXT', 'llama_retry_count INTEGER DEFAULT 0', 'llama_next_retry_at TEXT',
  'alert_sent_at TEXT', // material alerts: sent once, never re-sent on retry/re-analysis
  'llama_catalyst TEXT', 'llama_bearish_signal INTEGER',
]) {
  try { db.exec(`ALTER TABLE scout_sec_filings ADD COLUMN ${col}`); } catch {}
}

// Single-row settings table (id is always 1) — the "pause alerts without code changes"
// flag the spec asked for, plus the digest send-time and a dedup marker so the digest
// only fires once per day even if the discovery loop runs multiple times that day.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_alert_settings (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    alerts_paused          INTEGER DEFAULT 0,
    digest_time            TEXT DEFAULT '08:00',
    last_digest_sent_date  TEXT
  );
  INSERT OR IGNORE INTO scout_alert_settings (id) VALUES (1);
`);
// Repurposed as the general single-row "shared Proactive Scout UI state" slot —
// last_viewed_ticker backs osterm.html's cross-browser "which ticker was I just
// looking at" sync (there's no per-user session concept on that page, one shared
// basic_auth credential, so one shared value is the correct scope, same reasoning
// as alerts_paused above being a single flag rather than per-user).
try { db.exec(`ALTER TABLE scout_alert_settings ADD COLUMN last_viewed_ticker TEXT`); } catch {}

// ── Proactive Scout: raw sentiment pulls (Sentiment Crawler) ─────────────────
// Reuses the existing webSearch() (Perplexity + Ollama web search) already
// wired in for the web_search/get_market_news chat tools — no new crawler
// service. This stores the raw fetched text; deriving an actual sentiment
// score/contradiction-vs-SEC-filing read is the later Contradiction Engine's
// job, not this step's.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_sentiment (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker     TEXT,
    query      TEXT,
    content    TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sent_ticker   ON scout_sentiment(ticker);
  CREATE INDEX IF NOT EXISTS idx_sent_fetched  ON scout_sentiment(fetched_at);
`);

// ── Proactive Scout: Contradiction Engine results ─────────────────────────────
// Compares real SEC filing text (scout_sec_filings) against crawled sentiment
// (scout_sentiment) for a ticker via a small local Ollama model, flagging
// gaps between what was officially filed and what public sentiment says.
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_contradictions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT,
    sec_filing_ids      TEXT,
    sentiment_id        INTEGER,
    contradiction_found INTEGER,
    severity            TEXT,
    summary             TEXT,
    sec_position        TEXT,
    sentiment_position  TEXT,
    gaps_json           TEXT,
    confidence          REAL,
    model_used          TEXT,
    analyzed_at         TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sc_ticker ON scout_contradictions(ticker);
`);
// Additive migration: structured citation-based deliverable (issue+citation+category
// per contradiction, plus dilution/priority-of-claims/cash-flow impact paragraphs and
// the input sentiment score) replaced the old free-text-vs-free-text comparison.
for (const col of [
  'sentiment_score REAL', 'contradictions_json TEXT', 'dilution_risk TEXT',
  'priority_of_claims TEXT', 'cashflow_sensitivity TEXT', 'sections_used_json TEXT',
  'verdict TEXT', 'verdict_reason TEXT',
  // Deterministic Loughran-McDonald filing-tone score — separate from sentiment_score
  // (which is retail/market sentiment, LLM-derived or user-given). This is a pure
  // word-count computation over the filing's own Risk Factors + MD&A text; see
  // lmSentiment.js for the full pipeline.
  'filing_tone_lm_score INTEGER', 'filing_tone_lm_json TEXT',
  'dilution_features_json TEXT',
]) {
  try { db.exec(`ALTER TABLE scout_contradictions ADD COLUMN ${col}`); } catch {}
}

// ── Query Vault: validated-SQL memory mapped to human intent, so repeat
//    asks reuse a known-good query_trades SQL string instead of the model
//    re-deriving it from scratch each time ───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS query_vault (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    intent        TEXT NOT NULL,
    sql_query     TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_used     TEXT,
    success_count INTEGER NOT NULL DEFAULT 1
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_vault_intent ON query_vault(intent);
`);

// ── Bootstrap: import existing CSV into SQLite on startup ────────────────────
function extractUnderlying(symbol) {
  // Option symbol: "SPY 06/20/2025 500.00 P" → "SPY"
  const m = symbol.match(/^([A-Z]+)\s+\d{2}\/\d{2}\/\d{4}/);
  if (m) return m[1];
  // Equity: just the ticker
  return symbol.replace(/[^A-Z]/g, '').slice(0, 10) || symbol;
}
function parseCSVToRows(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const cells = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => row[h] = cells[i] || '');
    return row;
  }).filter(r => r.Date && r.Action && r.Symbol);
}
function seedDBFromCSV() {
  if (!fs.existsSync(CSV_FILE)) return;
  const n = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
  if (n > 0) return; // already has data
  try {
    const rows = parseCSVToRows(fs.readFileSync(CSV_FILE, 'utf8'));
    stmtInsertMany(rows.map(r => {
      const isOption = /\d{2}\/\d{2}\/\d{4}/.test(r.Symbol);
      return [
        r.Date, mmddyyyyToISO(r.Date), r.Action, r.Symbol,
        extractUnderlying(r.Symbol), isOption ? 'OPTION' : 'EQUITY',
        r.Description || '',
        parseFloat(r.Quantity) || 0,
        parseFloat(r.Price) || 0,
        parseFloat(r['Fees & Comm']) || 0,
        parseFloat(r.Amount) || 0,
        null, // time_iso — plain CSV has no time-of-day component
      ];
    }));
    console.log(`📥  Seeded SQLite from existing CSV: ${rows.length} rows`);
    autoJournalNewPositions(CHAT_MODEL).catch(e => console.error('❌  Auto-journal error:', e.message));
  } catch (e) { console.warn('CSV seed skipped:', e.message); }
}

const stmtUpsert = db.prepare(`
  INSERT OR IGNORE INTO trades
    (date_csv, date_iso, action, symbol, underlying, asset_type, description, quantity, price, fees, amount, time_iso)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtInsertMany = db.transaction((rows) => {
  for (const r of rows) stmtUpsert.run(r);
});
seedDBFromCSV();
rag.initRag(db);       // create rag_docs + journal_entries tables

// ── Journal schema migration (add IRS fields if not present) ─────────────────
['thesis TEXT DEFAULT ""', 'exit_reason TEXT DEFAULT ""', 'lessons TEXT DEFAULT ""',
 'rating INTEGER DEFAULT 0', 'tags TEXT DEFAULT ""', 'mistakes TEXT DEFAULT ""',
 // Auto-journaling fields — populated by autoJournalNewPositions() with zero manual input
 'source TEXT DEFAULT "manual"', 'objective TEXT DEFAULT ""',
 'market_iv_rank REAL', 'market_support REAL', 'market_resistance REAL',
 'legs_at_save INTEGER DEFAULT 0'
].forEach(col => { try { db.exec(`ALTER TABLE journal_entries ADD COLUMN ${col}`); } catch {} });

// ── SSL ───────────────────────────────────────────────────────────────────────
const CERT_FILE = path.join(CERTS_DIR, 'cert.pem');
const KEY_FILE  = path.join(CERTS_DIR, 'key.pem');
if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
  console.log('Generating self-signed SSL cert...');
  // Collect all local IPs for SANs so the cert works on any interface
  let extraIPs = '';
  try {
    const { networkInterfaces } = require('os');
    const ips = Object.values(networkInterfaces())
      .flat()
      .filter(n => !n.internal && (n.family === 'IPv4' || n.family === 4))
      .map(n => n.address);
    if (ips.length) extraIPs = ips.map(ip => `IP:${ip}`).join(',') + ',';
  } catch {}
  const san = `subjectAltName=IP:127.0.0.1,IP:::1,${extraIPs}DNS:localhost`;
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
    `-days 825 -nodes -subj "/CN=localhost" ` +
    `-addext "${san}"`,
    { stdio: 'ignore' }
  );
}
const ssl = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };

// ── Token helpers ─────────────────────────────────────────────────────────────
function loadTokens() {
  try { return fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : null; }
  catch { return null; }
}
function saveTokens(t) {
  t.saved_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}
function isTokenValid(tokens) {
  if (!tokens?.access_token) return false;
  const age = Date.now() - new Date(tokens.saved_at || 0).getTime();
  return age < (tokens.expires_in || 1800) * 1000 - 60000;
}
async function refreshToken(tokens) {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res   = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
  });
  const next = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(next)}`);
  saveTokens(next);
  return next;
}
async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated — visit /auth');
  if (!isTokenValid(tokens)) tokens = await refreshToken(tokens);
  return tokens.access_token;
}

// ── Gmail token helpers (mirrors the Schwab ones above) ───────────────────────
function loadGmailTokens() {
  try { return fs.existsSync(GMAIL_TOKEN_FILE) ? JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8')) : null; }
  catch { return null; }
}
function saveGmailTokens(t) {
  t.saved_at = new Date().toISOString();
  fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify(t, null, 2));
}
function isGmailTokenValid(tokens) {
  if (!tokens?.access_token) return false;
  const age = Date.now() - new Date(tokens.saved_at || 0).getTime();
  return age < (tokens.expires_in || 3600) * 1000 - 60000;
}
async function refreshGmailToken(tokens) {
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    }),
  });
  const next = await r.json();
  if (!r.ok) throw new Error(`Gmail token refresh failed: ${JSON.stringify(next)}`);
  // Google's refresh-token grant response does NOT include a new refresh_token — only
  // access_token/expires_in. Overwriting the saved object with `next` alone would lose
  // the refresh_token permanently. Merge onto the existing tokens instead.
  const merged = { ...tokens, ...next };
  saveGmailTokens(merged);
  return merged;
}
async function getGmailAccessToken() {
  let tokens = loadGmailTokens();
  if (!tokens) throw new Error('Gmail not authenticated — visit /auth/gmail');
  if (!isGmailTokenValid(tokens)) tokens = await refreshGmailToken(tokens);
  return tokens.access_token;
}

// RFC 2822 message, base64url-encoded, sent via Gmail API — no email-sending package
// needed (nodemailer etc.), just the same raw-fetch style already used for every other
// external API in this file (Schwab, Finnhub, SEC, Perplexity).
async function sendGmailAlert(subject, bodyText) {
  if (!GMAIL_SEND_TO) throw new Error('GMAIL_SEND_TO is not set');
  const token = await getGmailAccessToken();
  const message = [
    `To: ${GMAIL_SEND_TO}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
  ].join('\r\n');
  const raw = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail send failed: ${await r.text()}`);
  return r.json();
}

// ── Account hash ──────────────────────────────────────────────────────────────
async function getAccountHash(token) {
  if (fs.existsSync(HASH_FILE)) return JSON.parse(fs.readFileSync(HASH_FILE, 'utf8'));
  const res  = await fetch(`${API_BASE}/accounts/accountNumbers`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok || !data.length) throw new Error('Could not fetch account numbers');
  const info = { accountNumber: data[0].accountNumber, hash: data[0].hashValue };
  fs.writeFileSync(HASH_FILE, JSON.stringify(info, null, 2));
  return info;
}

// ── Transaction converter ─────────────────────────────────────────────────────
function toMMDDYYYY(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;
}
function mmddyyyyToISO(d) {
  if (!d) return null;
  // Handle Schwab "as of" settlement format: "06/22/2026 as of 06/18/2026"
  // Use the actual event date (after "as of"), not the settlement date
  const asOf = d.match(/as of\s+(\d{2}\/\d{2}\/\d{4})/i);
  const clean = asOf ? asOf[1] : d.trim().split(' ')[0];
  const [m, day, y] = clean.split('/');
  if (!m || !day || !y || y.length !== 4) return null;
  return `${y}-${m.padStart(2,'0')}-${day.padStart(2,'0')}`;
}
function toOptionSymbol(inst) {
  return `${inst.underlyingSymbol} ${toMMDDYYYY(inst.expirationDate)} ${parseFloat(inst.strikePrice).toFixed(2)} ${inst.putCall === 'PUT' ? 'P' : 'C'}`;
}

// The Transaction History API's instrument objects carry strikePrice/expirationDate
// directly (toOptionSymbol above relies on that) — but the live Positions API's
// instrument objects do NOT include those fields at all, confirmed against a real
// account response. The only place strike/expiry exist there is inside the human
// description string, e.g. "TESLA INC 06/17/2027 $150 Put". Parse it from there.
function parsePositionOptionInstrument(desc) {
  const m = (desc || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+\$([\d.]+)\s+(Put|Call)/i);
  if (!m) return { strike: null, expiry: null };
  const [, mm, dd, yyyy, strike] = m;
  return { strike: Number(strike), expiry: `${yyyy}-${mm}-${dd}` };
}
function toAction(inst, positionEffect, amount, txnType, description) {
  const desc = (description || '').toLowerCase();
  if (txnType === 'RECEIVE_AND_DELIVER') {
    if (inst.assetType !== 'OPTION') return null;
    if (desc.includes('expir'))    return 'Expired';
    if (desc.includes('assigned')) return 'Assigned';
    if (desc.includes('exercis'))  return 'Exercised';
    return null;
  }
  if (inst.assetType === 'OPTION') {
    const sold = amount < 0;
    if (positionEffect === 'OPENING') return sold ? 'Sell to Open'  : 'Buy to Open';
    if (positionEffect === 'CLOSING') return sold ? 'Sell to Close' : 'Buy to Close';
    return null;
  }
  if (inst.assetType === 'EQUITY') return amount > 0 ? 'Buy' : 'Sell';
  return null;
}
function convertTxn(t) {
  const legs = (t.transferItems || []).filter(i => i.instrument?.assetType !== 'CURRENCY');
  if (!legs.length) return null;
  const fees   = (t.transferItems || [])
    .filter(i => i.instrument?.assetType === 'CURRENCY' && i.feeType)
    .reduce((s, i) => s + Math.abs(i.amount || 0), 0);
  const leg    = legs[0];
  const inst   = leg.instrument;
  const action = toAction(inst, leg.positionEffect, leg.amount, t.type, t.description);
  if (!action) return null;
  const symbol = inst.assetType === 'OPTION' ? toOptionSymbol(inst) : inst.symbol;
  if (!symbol) return null;
  return {
    'Date':        toMMDDYYYY(t.settlementDate || t.tradeDate || t.time),
    'Action':      action,
    'Symbol':      symbol,
    'Description': inst.description || '',
    'Quantity':    String(Math.abs(leg.amount || 0)),
    'Price':       (leg.price || 0).toFixed(4),
    'Fees & Comm': fees > 0 ? fees.toFixed(2) : '',
    'Amount':      (t.netAmount || 0).toFixed(2),
    'AcctgRuleCd': '',
    // internal fields for SQLite (not written to CSV)
    _underlying: inst.underlyingSymbol || inst.symbol || '',
    _assetType:  inst.assetType || '',
    _timeIso:    t.tradeDate || t.time || null, // full timestamp, if Schwab provided one
  };
}
function rowsToCSV(rows) {
  const headers = ['Date','Action','Symbol','Description','Quantity','Price','Fees & Comm','Amount','AcctgRuleCd'];
  const lines   = [headers.join(',')];
  for (const row of rows)
    lines.push(headers.map(h => { const v = String(row[h] ?? ''); return v.includes(',') ? `"${v}"` : v; }).join(','));
  return lines.join('\n');
}

// ── Sync status ───────────────────────────────────────────────────────────────
function loadSyncStatus() {
  try { return fs.existsSync(STATUS_FILE) ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) : {}; } catch { return {}; }
}
function saveSyncStatus(s) { fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2)); }
let syncStatus = { running: false, ...loadSyncStatus() };

async function runSync({ days, startDate, endDate } = {}) {
  syncStatus.running = true;
  try {
    const token = await getAccessToken();
    const acct  = await getAccountHash(token);
    const end   = endDate   ? new Date(endDate + 'T23:59:59Z') : new Date();
    const start = startDate ? new Date(startDate + 'T00:00:00Z')
                            : new Date(end.getTime() - (days || 90) * 86400000);

    const fetchType = async (type) => {
      const p   = new URLSearchParams({ startDate: start.toISOString(), endDate: end.toISOString(), types: type });
      const res = await fetch(`${API_BASE}/accounts/${acct.hash}/transactions?${p}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`API error (${type}): ${JSON.stringify(body)}`);
      return body;
    };

    const [trades, deliveries] = await Promise.all([fetchType('TRADE'), fetchType('RECEIVE_AND_DELIVER')]);
    const rows  = [...trades, ...deliveries].map(convertTxn).filter(Boolean);
    const csv   = rowsToCSV(rows);
    fs.writeFileSync(CSV_FILE, csv, 'utf8');

    // Persist to SQLite
    stmtInsertMany(rows.map(r => [
      r.Date, mmddyyyyToISO(r.Date), r.Action, r.Symbol,
      r._underlying, r._assetType, r.Description,
      parseFloat(r.Quantity) || 0,
      parseFloat(r.Price) || 0,
      parseFloat(r['Fees & Comm']) || 0,
      parseFloat(r.Amount) || 0,
      r._timeIso || null,
    ]));

    // Self-documenting audit trail — auto-journal any position with new legs.
    // Fire-and-forget so a slow Ollama/market-data round trip never blocks sync.
    autoJournalNewPositions(CHAT_MODEL).catch(e => console.error('❌  Auto-journal error:', e.message));

    // Refresh sector classifications for any newly-seen tickers. Fire-and-forget,
    // no-ops silently if FINNHUB_API_KEY isn't set.
    sectors.refreshSectorCache(db, FINNHUB_API_KEY).catch(e => console.error('❌  Sector cache refresh error:', e.message));

    // Snapshot today's margin-usage ratio for the Risk Thermometer's history sparkline.
    fetchLiveAccountSnapshot()
      .then(snap => riskMetrics.snapshotRiskRatio(db, snap.balances))
      .catch(e => console.error('❌  Risk snapshot error:', e.message));

    const actionCounts = {};
    for (const r of rows) actionCounts[r.Action] = (actionCounts[r.Action] || 0) + 1;
    const dbTotal = db.prepare('SELECT COUNT(*) as n FROM trades').get().n;
    const rangeLabel = startDate ? `${startDate} → ${endDate || 'today'}` : `${days || 90}d`;

    syncStatus = { running: false, lastRun: new Date().toISOString(), lastCount: rows.length, dbTotal, lastError: null, actionCounts, days: days || null, startDate: start.toISOString().slice(0,10), endDate: end.toISOString().slice(0,10), account: acct.accountNumber };
    saveSyncStatus(syncStatus);
    console.log(`✅  Sync complete: ${rows.length} rows (${rangeLabel}), ${dbTotal} total in DB`);
  } catch (err) {
    syncStatus = { ...syncStatus, running: false, lastRun: new Date().toISOString(), lastError: err.message };
    saveSyncStatus(syncStatus);
    console.error('❌  Sync failed:', err.message);
  }
}

// ── Adaptive period breakdown ─────────────────────────────────────────────────
function computeBreakdown(fromDate, toDate, where, params) {
  const minDate = fromDate || db.prepare('SELECT MIN(date_iso) as m FROM trades').get()?.m;
  const maxDate = toDate   || db.prepare('SELECT MAX(date_iso) as m FROM trades').get()?.m;
  if (!minDate || !maxDate) return { granularity: 'day', rows: [] };

  const days = (new Date(maxDate) - new Date(minDate)) / 86400000;
  let groupExpr, granularity;
  if      (days > 548) { groupExpr = "substr(date_iso, 1, 4)";          granularity = 'year';  }
  else if (days > 60)  { groupExpr = "substr(date_iso, 1, 7)";          granularity = 'month'; }
  else if (days > 13)  { groupExpr = "strftime('%Y-W%W', date_iso)";    granularity = 'week';  }
  else                 { groupExpr = "date_iso";                         granularity = 'day';   }

  const rows = db.prepare(
    `SELECT ${groupExpr} as period, SUM(amount) as pnl, COUNT(*) as count
     FROM trades ${where} GROUP BY period ORDER BY period`
  ).all(...params);
  return { granularity, rows };
}

// ── Dashboard metrics from SQLite ─────────────────────────────────────────────
function computeDashboard(fromDate, toDate, ticker) {
  const dbTotal = db.prepare('SELECT COUNT(*) as n FROM trades').get().n;
  if (dbTotal === 0) return null;

  // Parameterized WHERE clauses
  const conds = [];
  const params = [];
  if (fromDate) { conds.push('date_iso >= ?'); params.push(fromDate); }
  if (toDate)   { conds.push('date_iso <= ?'); params.push(toDate);   }
  if (ticker)   { conds.push("COALESCE(underlying, symbol) = ?"); params.push(ticker.toUpperCase()); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  // Options-only WHERE (main P&L stats — options premium is always realized cash)
  const optConds = [...conds, "asset_type = 'OPTION'"];
  const optWhere = 'WHERE ' + optConds.join(' AND ');

  const qGet = sql => db.prepare(sql).get(...params);

  const filteredTotal  = qGet(`SELECT COUNT(*) as n FROM trades ${where}`).n;
  const optionsTotal   = qGet(`SELECT COUNT(*) as n FROM trades ${optWhere}`).n;

  // ── Options P&L curve (only realized options premium) ──────────────────────
  const pnlCurve = db.prepare(
    `SELECT date_iso, SUM(amount) as daily_pnl FROM trades ${optWhere} GROUP BY date_iso ORDER BY date_iso`
  ).all(...params);
  let cum = 0;
  const curve = pnlCurve.map(r => ({ date: r.date_iso, cum: +(cum += r.daily_pnl).toFixed(2) }));

  // ── Options positions (group by contract symbol — each is a unique contract) ─
  const positions = db.prepare(`
    SELECT symbol, underlying, asset_type,
           SUM(amount) as net_pnl, SUM(fees) as total_fees,
           COUNT(*) as legs, MIN(date_iso) as opened, MAX(date_iso) as closed,
           GROUP_CONCAT(DISTINCT action) as actions
    FROM trades ${optWhere} GROUP BY symbol
  `).all(...params);

  const closingActs = new Set(['Buy to Close','Sell to Close','Expired','Assigned','Exercised']);
  const openingActs = new Set(['Sell to Open','Buy to Open']);
  const hasClose    = p => p.actions.split(',').some(a => closingActs.has(a.trim()));
  const hasOpen     = p => p.actions.split(',').some(a => openingActs.has(a.trim()));
  const allExpired  = p => p.actions.split(',').every(a => a.trim() === 'Expired');

  const allClosed = positions.filter(p => (hasClose(p) && hasOpen(p)) || allExpired(p));
  let totalGain = 0, totalLoss = 0, winCount = 0, lossCount = 0;
  const distBuckets = {};

  for (const pos of allClosed) {
    const pnl = pos.net_pnl;
    if (pnl > 0) { totalGain += pnl; winCount++; }
    else          { totalLoss += pnl; lossCount++; }
    const bucket = Math.round(pnl / 50) * 50;
    const key    = bucket >= 0 ? `+${bucket}` : `${bucket}`;
    distBuckets[key] = (distBuckets[key] || 0) + 1;
  }

  const totalTrades  = winCount + lossCount;
  const winRate      = totalTrades > 0 ? winCount / totalTrades * 100 : 0;
  const profitRate   = (totalGain + Math.abs(totalLoss)) > 0
    ? totalGain / (totalGain + Math.abs(totalLoss)) * 100 : 0;

  // ── Top underlyings by options P&L ─────────────────────────────────────────
  const topSymbols = db.prepare(`
    SELECT COALESCE(underlying, symbol) as ticker,
           SUM(amount) as net_pnl, COUNT(DISTINCT symbol) as contracts
    FROM trades ${optWhere} GROUP BY ticker ORDER BY net_pnl DESC LIMIT 10
  `).all(...params);

  // ── Stock realized P&L (only tickers that have BOTH buys and sells) ─────────
  const eqConds  = [...conds, "asset_type = 'EQUITY'"];
  const eqWhere  = 'WHERE ' + eqConds.join(' AND ');
  const eqBySymbol = db.prepare(`
    SELECT symbol,
           SUM(CASE WHEN action='Buy'  THEN amount ELSE 0 END) as buy_total,
           SUM(CASE WHEN action='Sell' THEN amount ELSE 0 END) as sell_total,
           COUNT(CASE WHEN action='Buy'  THEN 1 END) as buy_count,
           COUNT(CASE WHEN action='Sell' THEN 1 END) as sell_count
    FROM trades ${eqWhere} GROUP BY symbol
  `).all(...params);

  // Only count equity symbols where sales >= purchases (closed/partially closed)
  let stockPnL = 0;
  for (const eq of eqBySymbol) {
    if (eq.sell_count > 0) {
      // Realized portion: ratio of sells to buys applied to net
      const ratio = eq.buy_count > 0 ? Math.min(eq.sell_count / eq.buy_count, 1) : 1;
      stockPnL += eq.sell_total + (eq.buy_total * ratio);
    }
  }

  const byAction = db.prepare(
    `SELECT action, COUNT(*) as count, SUM(amount) as total FROM trades ${where} GROUP BY action ORDER BY count DESC`
  ).all(...params);

  const totalFees    = qGet(`SELECT COALESCE(SUM(fees),0) as t FROM trades ${where}`).t;
  const optionsFees  = qGet(`SELECT COALESCE(SUM(fees),0) as t FROM trades ${optWhere}`).t;

  const distribution = Object.entries(distBuckets)
    .map(([bucket, count]) => ({ bucket, count, value: parseFloat(bucket.replace('+','')) }))
    .sort((a, b) => a.value - b.value);

  const breakdown = computeBreakdown(fromDate, toDate, optWhere, params);

  return {
    total: filteredTotal, optionsTotal, dbTotal, curve, topSymbols, distribution, breakdown, byAction,
    stats: {
      netPnL:  totalGain + totalLoss,          // options P&L only
      stockPnL,                                 // realized equity P&L (approx)
      totalPnL: (totalGain + totalLoss) + stockPnL,
      totalGain, totalLoss, winCount, lossCount, totalTrades, winRate, profitRate,
      avgGain:  winCount  > 0 ? totalGain / winCount  : 0,
      avgLoss:  lossCount > 0 ? totalLoss / lossCount : 0,
      plRatio:  lossCount > 0 && winCount > 0 ? (totalGain / winCount) / Math.abs(totalLoss / lossCount) : 0,
      profitFactor: totalLoss !== 0 ? totalGain / Math.abs(totalLoss) : 0,
      totalFees, optionsFees,
    },
  };
}

// ── Performance Coach: Year-over-Year + Seasonality ──────────────────────────
function computeYoY(ticker) {
  const conds = ["asset_type = 'OPTION'"];
  const params = [];
  if (ticker) { conds.push("COALESCE(underlying, symbol) = ?"); params.push(ticker.toUpperCase()); }
  const where = 'WHERE ' + conds.join(' AND ');

  const byYear = db.prepare(`
    SELECT substr(date_iso,1,4) as year, SUM(amount) as pnl, COUNT(*) as count
    FROM trades ${where} GROUP BY year ORDER BY year
  `).all(...params);

  const byYearMonth = db.prepare(`
    SELECT substr(date_iso,1,4) as year, substr(date_iso,6,2) as month,
           SUM(amount) as pnl, COUNT(*) as count
    FROM trades ${where} GROUP BY year, month ORDER BY year, month
  `).all(...params);

  // Best/worst year, highest win rate year, most-consistent (lowest drawdown) year —
  // win rate and drawdown need daily curves, computed per year below.
  let bestYear = null, worstYear = null;
  for (const y of byYear) {
    if (!bestYear  || y.pnl > bestYear.pnl)  bestYear  = y;
    if (!worstYear || y.pnl < worstYear.pnl) worstYear = y;
  }

  const summary = byYear.map(y => {
    const dailyRows = db.prepare(`
      SELECT date_iso, SUM(amount) as pnl FROM trades ${where} AND substr(date_iso,1,4) = ?
      GROUP BY date_iso ORDER BY date_iso
    `).all(...params, y.year);
    let cum = 0, peak = 0, maxDrawdown = 0, wins = 0, closedDays = 0, grossGain = 0, grossLoss = 0;
    for (const d of dailyRows) {
      cum += d.pnl;
      if (cum > peak) peak = cum;
      maxDrawdown = Math.min(maxDrawdown, cum - peak);
      if (d.pnl !== 0) {
        closedDays++;
        if (d.pnl > 0) { wins++; grossGain += d.pnl; } else { grossLoss += d.pnl; }
      }
    }
    return {
      year: y.year, pnl: y.pnl, count: y.count,
      winRate: closedDays > 0 ? (wins / closedDays) * 100 : 0,
      maxDrawdown,
      // Risk-adjusted return substitute for "R-multiple" — a raw R-multiple doesn't
      // map cleanly onto an options premium-selling book, so profit factor
      // (gross gains / gross losses on winning vs. losing days) stands in instead.
      profitFactor: grossLoss !== 0 ? grossGain / Math.abs(grossLoss) : 0,
    };
  });

  let highestWinRateYear = null, mostConsistentYear = null;
  for (const s of summary) {
    if (!highestWinRateYear || s.winRate > highestWinRateYear.winRate) highestWinRateYear = s;
    // "most consistent" = smallest-magnitude drawdown (maxDrawdown is <= 0)
    if (!mostConsistentYear || s.maxDrawdown > mostConsistentYear.maxDrawdown) mostConsistentYear = s;
  }

  return {
    byYear, byYearMonth, summary,
    bestYear: bestYear?.year || null,
    worstYear: worstYear?.year || null,
    highestWinRateYear: highestWinRateYear?.year || null,
    mostConsistentYear: mostConsistentYear?.year || null,
  };
}

function computeSeasonality(ticker) {
  const conds = ["asset_type = 'OPTION'"];
  const params = [];
  if (ticker) { conds.push("COALESCE(underlying, symbol) = ?"); params.push(ticker.toUpperCase()); }
  const where = 'WHERE ' + conds.join(' AND ');

  const byDOW = db.prepare(`
    SELECT strftime('%w', date_iso) as dow, SUM(amount) as pnl, AVG(amount) as avg_pnl, COUNT(*) as n
    FROM trades ${where} GROUP BY dow
  `).all(...params);

  const byMonth = db.prepare(`
    SELECT substr(date_iso,6,2) as month, SUM(amount) as pnl, AVG(amount) as avg_pnl, COUNT(*) as n
    FROM trades ${where} GROUP BY month ORDER BY month
  `).all(...params);

  // Time-of-day buckets — only meaningful once time_iso is populated (see the
  // schema migration above); rows without it are simply excluded, not faked.
  const byTimeOfDay = db.prepare(`
    SELECT
      CASE
        WHEN strftime('%H', time_iso) BETWEEN '09' AND '10' THEN 'Open (9:30-11am)'
        WHEN strftime('%H', time_iso) BETWEEN '11' AND '13' THEN 'Midday (11am-2pm)'
        ELSE 'Close (2-4pm)'
      END as session,
      SUM(amount) as pnl, AVG(amount) as avg_pnl, COUNT(*) as n
    FROM trades ${where} AND time_iso IS NOT NULL
    GROUP BY session
  `).all(...params);

  return { byDOW, byMonth, byTimeOfDay };
}

// ── Performance Coach: benchmark vs. SPY buy-and-hold ────────────────────────
async function computeBenchmarkComparison(fromDate, toDate) {
  const conds = ["asset_type = 'OPTION'"];
  const params = [];
  if (fromDate) { conds.push('date_iso >= ?'); params.push(fromDate); }
  if (toDate)   { conds.push('date_iso <= ?'); params.push(toDate); }
  const where = 'WHERE ' + conds.join(' AND ');

  const dailyRows = db.prepare(
    `SELECT date_iso, SUM(amount) as pnl FROM trades ${where} GROUP BY date_iso ORDER BY date_iso`
  ).all(...params);
  if (!dailyRows.length) return { available: false, reason: 'No trades in range' };

  // Trades seeded before live Schwab sync could reach that far back all carry
  // amount=0 (a data-source cutover, not real flat performance) — a long zero
  // prefix. Comparing that stretch's "$0 P&L" against SPY's real return would
  // silently understate you, so when no explicit fromDate is given, clip to
  // where priced data actually starts.
  let usableRows = dailyRows;
  let dataStartNote = null;
  if (!fromDate) {
    const firstRealIdx = dailyRows.findIndex(r => r.pnl !== 0);
    if (firstRealIdx > 0) {
      dataStartNote = `Comparison starts ${dailyRows[firstRealIdx].date_iso} — ${firstRealIdx} earlier day(s) had no priced P&L data (likely pre-dating live sync coverage) and were excluded rather than counted as $0.`;
      usableRows = dailyRows.slice(firstRealIdx);
    }
  }

  let cum = 0;
  const yourCurve = usableRows.map(r => ({ date: r.date_iso, cum: (cum += r.pnl) }));
  const yourPnl = cum;

  const rangeStart = fromDate || usableRows[0].date_iso;
  const rangeEnd   = toDate   || usableRows[usableRows.length - 1].date_iso;
  const startMs = new Date(rangeStart + 'T00:00:00Z').getTime();
  const endMs   = new Date(rangeEnd   + 'T23:59:59Z').getTime();

  const snapshot = await fetchLiveAccountSnapshot().catch(() => null);
  const baseline = snapshot?.balances?.liquidationValue || null;

  // Fetch a generously long window (max valid Schwab "year" period) and filter
  // client-side to the actual range — avoids depending on startDate/endDate
  // query-param support, which isn't exercised anywhere else in this codebase.
  const spyData = await schwabMarket('/pricehistory', {
    symbol: 'SPY', periodType: 'year', period: 15, frequencyType: 'daily', frequency: 1,
  });
  const candles = (spyData.candles || []).filter(c => c.datetime >= startMs && c.datetime <= endMs);
  if (spyData.error || candles.length < 2) {
    return { available: false, reason: spyData.error || 'Not enough SPY price history for this range', yourPnl, yourCurve, baseline, dataStartNote };
  }

  const startPrice = candles[0].close;
  const spyReturnPct = (candles[candles.length - 1].close - startPrice) / startPrice;
  const spyCurve = candles.map(c => ({
    date: new Date(c.datetime).toISOString().slice(0, 10),
    cum: baseline != null ? baseline * ((c.close - startPrice) / startPrice) : null,
  }));

  return {
    available: true,
    yourPnl, yourCurve,
    spyReturnPct: spyReturnPct * 100,
    spyDollarEquivalent: baseline != null ? baseline * spyReturnPct : null,
    spyCurve, baseline,
    baselineNote: "SPY's dollar-equivalent uses your CURRENT account liquidation value as a notional baseline, not your actual starting capital for this period (that history isn't tracked) — treat this as an approximate comparison, not a precise one.",
    dataStartNote,
  };
}

function computeSectorBreakdown(fromDate, toDate) {
  const conds = ["t.asset_type = 'OPTION'"];
  const params = [];
  if (fromDate) { conds.push('t.date_iso >= ?'); params.push(fromDate); }
  if (toDate)   { conds.push('t.date_iso <= ?'); params.push(toDate); }
  const where = 'WHERE ' + conds.join(' AND ');

  return db.prepare(`
    SELECT COALESCE(s.sector, 'Unclassified') as sector,
           SUM(t.amount) as pnl, COUNT(*) as count,
           COUNT(DISTINCT COALESCE(t.underlying, t.symbol)) as tickers
    FROM trades t
    LEFT JOIN sector_cache s ON s.symbol = COALESCE(t.underlying, t.symbol)
    ${where}
    GROUP BY sector ORDER BY pnl DESC
  `).all(...params);
}

function _addMonths(period, offset) {
  const m = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function _projectMonthlySeries(points, valueKey, horizon = 6) {
  const rows = Array.isArray(points) ? points : [];
  const labels = rows.map(r => r.period);
  const values = rows.map(r => Number(r?.[valueKey] || 0));
  if (rows.length < 2 || horizon <= 0) {
    return { labels, values, projectedLabels: [], projectedValues: [] };
  }

  const n = values.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = values[i];
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? ((n * sxy - sx * sy) / denom) : 0;
  const intercept = (sy - slope * sx) / n;

  const projectedLabels = [];
  const projectedValues = [];
  const last = labels[labels.length - 1];
  for (let i = 1; i <= horizon; i++) {
    const next = _addMonths(last, i);
    if (!next) break;
    projectedLabels.push(next);
    projectedValues.push(Number((intercept + slope * (n - 1 + i)).toFixed(2)));
  }
  return { labels, values, projectedLabels, projectedValues };
}

function computeAdvancedAnalytics({
  fromDate = null,
  toDate = null,
  ticker = null,
  federalRateST = 0.32,
  federalRateLT = 0.15,
  stateRate = 0.05,
  projectionMonths = 6,
} = {}) {
  const conds = [];
  const params = [];
  if (fromDate) { conds.push('date_iso >= ?'); params.push(fromDate); }
  if (toDate)   { conds.push('date_iso <= ?'); params.push(toDate); }
  if (ticker)   { conds.push('COALESCE(underlying, symbol) = ?'); params.push(String(ticker).toUpperCase()); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const optConds = [...conds, "asset_type='OPTION'"];
  const optWhere = `WHERE ${optConds.join(' AND ')}`;

  const lots = db.prepare(`
    SELECT t.symbol, t.underlying,
           MIN(t.date_iso) as date_acquired,
           MAX(t.date_iso) as date_sold,
           SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as proceeds,
           SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as cost_basis,
           SUM(t.amount) as net_pnl,
           SUM(t.fees) as total_fees,
           CAST(julianday(MAX(t.date_iso)) - julianday(MIN(t.date_iso)) AS INTEGER) as holding_days
    FROM trades t
    ${optWhere}
    GROUP BY t.symbol
    HAVING COUNT(*) > 0
    ORDER BY MAX(t.date_iso) ASC
  `).all(...params);

  const allOptionTrades = db.prepare(`
    SELECT underlying, date_iso, action
    FROM trades
    WHERE asset_type='OPTION'
  `).all();

  const lotsWithWash = lots.map(r => {
    const term = r.holding_days < 366 ? 'short' : 'long';
    let wsAdj = 0;
    if ((r.net_pnl || 0) < 0) {
      const sold = new Date(r.date_sold);
      const win30 = allOptionTrades.filter(t =>
        t.underlying === r.underlying &&
        t.date_iso !== r.date_sold &&
        Math.abs(new Date(t.date_iso) - sold) <= 30 * 86400000 &&
        (t.action === 'Sell to Open' || t.action === 'Buy to Open')
      );
      if (win30.length > 0) wsAdj = Math.abs(r.net_pnl || 0);
    }
    const gainLoss = Number((Number(r.net_pnl || 0) + wsAdj).toFixed(2));
    return {
      ...r,
      term,
      ws_adjustment: Number(wsAdj.toFixed(2)),
      gain_loss: gainLoss,
      net_pnl: Number((r.net_pnl || 0).toFixed(2)),
      total_fees: Number((r.total_fees || 0).toFixed(2)),
    };
  });

  const sumBy = (rows, key) => rows.reduce((s, r) => s + Number(r?.[key] || 0), 0);
  const shortRows = lotsWithWash.filter(r => r.term === 'short');
  const longRows = lotsWithWash.filter(r => r.term === 'long');
  const shortNet = sumBy(shortRows, 'gain_loss');
  const longNet = sumBy(longRows, 'gain_loss');
  const washDisallowed = sumBy(lotsWithWash, 'ws_adjustment');
  const realizedNet = shortNet + longNet;

  const taxableST = Math.max(0, shortNet);
  const taxableLT = Math.max(0, longNet);
  const estFederal = taxableST * federalRateST + taxableLT * federalRateLT;
  const estState = Math.max(0, realizedNet) * stateRate;
  const estTotal = estFederal + estState;
  const estNetAfterFeesAndTaxes = realizedNet - estTotal;
  const effectiveTaxRate = realizedNet > 0 ? estTotal / realizedNet : 0;
  const effectiveFederalTaxRate = realizedNet > 0 ? estFederal / realizedNet : 0;
  const effectiveStateTaxRate = realizedNet > 0 ? estState / realizedNet : 0;
  const retentionRateAfterTax = realizedNet > 0 ? estNetAfterFeesAndTaxes / realizedNet : 0;
  const quarterly = estTotal / 4;
  const estCarryforwardLoss = Math.max(0, -realizedNet);

  const totalFees = Number(db.prepare(`SELECT COALESCE(SUM(fees),0) as t FROM trades ${where}`).get(...params)?.t || 0);
  const optionFees = Number(db.prepare(`SELECT COALESCE(SUM(fees),0) as t FROM trades ${optWhere}`).get(...params)?.t || 0);
  const equityFees = Math.max(0, totalFees - optionFees);

  const feesByAction = db.prepare(`
    SELECT action, COUNT(*) as count, COALESCE(SUM(fees),0) as fees
    FROM trades ${where}
    GROUP BY action
    ORDER BY fees DESC
  `).all(...params).map(r => ({ ...r, fees: Number((r.fees || 0).toFixed(2)) }));

  const topLosses = lotsWithWash
    .filter(r => Number(r.net_pnl || 0) < 0)
    .sort((a, b) => a.net_pnl - b.net_pnl)
    .slice(0, 15)
    .map(r => ({
      symbol: r.symbol,
      underlying: r.underlying,
      date_sold: r.date_sold,
      net_pnl: r.net_pnl,
      ws_adjustment: r.ws_adjustment,
      gain_loss: r.gain_loss,
      term: r.term,
    }));

  const lossByUnderlyingMap = new Map();
  for (const r of lotsWithWash.filter(x => x.net_pnl < 0)) {
    const key = r.underlying || 'UNKNOWN';
    const cur = lossByUnderlyingMap.get(key) || { underlying: key, loss: 0, trades: 0 };
    cur.loss += Math.abs(Number(r.net_pnl || 0));
    cur.trades += 1;
    lossByUnderlyingMap.set(key, cur);
  }
  const lossByUnderlying = [...lossByUnderlyingMap.values()].sort((a, b) => b.loss - a.loss).slice(0, 12)
    .map(r => ({ ...r, loss: Number(r.loss.toFixed(2)) }));

  const washByUnderlyingMap = new Map();
  for (const r of lotsWithWash.filter(x => Number(x.ws_adjustment || 0) > 0)) {
    const key = r.underlying || 'UNKNOWN';
    const cur = washByUnderlyingMap.get(key) || { underlying: key, disallowed: 0, trades: 0 };
    cur.disallowed += Number(r.ws_adjustment || 0);
    cur.trades += 1;
    washByUnderlyingMap.set(key, cur);
  }
  const washByUnderlying = [...washByUnderlyingMap.values()].sort((a, b) => b.disallowed - a.disallowed).slice(0, 12)
    .map(r => ({ ...r, disallowed: Number(r.disallowed.toFixed(2)) }));

  const monthly = db.prepare(`
    SELECT substr(date_iso,1,7) as period,
           SUM(amount) as pnl,
           SUM(fees) as fees,
           COUNT(*) as trades
    FROM trades ${where}
    GROUP BY period
    ORDER BY period
  `).all(...params).map(r => ({
    period: r.period,
    pnl: Number((r.pnl || 0).toFixed(2)),
    fees: Number((r.fees || 0).toFixed(2)),
    trades: Number(r.trades || 0),
  }));

  const projectionH = Math.max(1, Math.min(18, Number(projectionMonths || 6)));
  const pnlProjection = _projectMonthlySeries(monthly, 'pnl', projectionH);
  const feeProjection = _projectMonthlySeries(monthly, 'fees', projectionH);

  const reportLines = [
    `Realized net gain/loss: $${realizedNet.toFixed(2)}`,
    `Short-term: $${shortNet.toFixed(2)} | Long-term: $${longNet.toFixed(2)}`,
    `Wash-sale disallowed estimate: $${washDisallowed.toFixed(2)}`,
    `Fees paid: $${totalFees.toFixed(2)} (options $${optionFees.toFixed(2)}, equity $${equityFees.toFixed(2)}) — already embedded in realized P&L`,
    `Estimated taxes: Federal $${estFederal.toFixed(2)} (${(effectiveFederalTaxRate * 100).toFixed(1)}% effective) + State $${estState.toFixed(2)} (${(effectiveStateTaxRate * 100).toFixed(1)}% effective) = $${estTotal.toFixed(2)} (${(effectiveTaxRate * 100).toFixed(1)}% effective)`,
    `Estimated net P&L after fees and taxes: $${estNetAfterFeesAndTaxes.toFixed(2)} (${(retentionRateAfterTax * 100).toFixed(1)}% kept)`,
    `Quarterly estimate: $${quarterly.toFixed(2)} | Loss carryforward estimate: $${estCarryforwardLoss.toFixed(2)}`,
    `IRS source note: capital gains/losses terminology aligns to IRS FAQ "Stocks (options, splits, traders)" at irs.gov; actual tax rates here are user-configurable estimates, not IRS-provided rates.`,
  ];

  return {
    meta: {
      fromDate,
      toDate,
      ticker: ticker || null,
      generatedAt: new Date().toISOString(),
      projectionMonths: projectionH,
      irsSource: {
        url: 'https://www.irs.gov/faqs/capital-gains-losses-and-sale-of-home/stocks-options-splits-traders',
        title: 'IRS FAQ: Stocks (options, splits, traders)',
        lastReviewed: '2025-12-04',
      },
    },
    assumptions: {
      federalRateST,
      federalRateLT,
      stateRate,
    },
    summary: {
      lots: lotsWithWash.length,
      realizedNet: Number(realizedNet.toFixed(2)),
      shortNet: Number(shortNet.toFixed(2)),
      longNet: Number(longNet.toFixed(2)),
      washDisallowed: Number(washDisallowed.toFixed(2)),
      totalFees: Number(totalFees.toFixed(2)),
      optionFees: Number(optionFees.toFixed(2)),
      equityFees: Number(equityFees.toFixed(2)),
      estFederal: Number(estFederal.toFixed(2)),
      estState: Number(estState.toFixed(2)),
      estTotal: Number(estTotal.toFixed(2)),
      estNetAfterFeesAndTaxes: Number(estNetAfterFeesAndTaxes.toFixed(2)),
      effectiveTaxRate: Number(effectiveTaxRate.toFixed(6)),
      effectiveFederalTaxRate: Number(effectiveFederalTaxRate.toFixed(6)),
      effectiveStateTaxRate: Number(effectiveStateTaxRate.toFixed(6)),
      retentionRateAfterTax: Number(retentionRateAfterTax.toFixed(6)),
      quarterly: Number(quarterly.toFixed(2)),
      estCarryforwardLoss: Number(estCarryforwardLoss.toFixed(2)),
    },
    washSales: {
      tradesFlagged: lotsWithWash.filter(r => Number(r.ws_adjustment || 0) > 0).length,
      byUnderlying: washByUnderlying,
    },
    fees: {
      byAction: feesByAction,
    },
    losses: {
      topTrades: topLosses,
      byUnderlying: lossByUnderlying,
    },
    trends: {
      monthly,
      pnlProjection,
      feeProjection,
    },
    report: reportLines.join('\n'),
  };
}

// ── CSV file parser ───────────────────────────────────────────────────────────
function parseCSVFile(limit = 30) {
  if (!fs.existsSync(CSV_FILE)) return [];
  const lines = fs.readFileSync(CSV_FILE, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).slice(-limit).reverse().map(line => {
    const cells = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ''; });
    return row;
  });
}

// ── Express ───────────────────────────────────────────────────────────────────
const app    = express();
const states = new Map();
app.use(express.urlencoded({ extended: false, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// ── API: Scout Ingest ─────────────────────────────────────────────────────────
// Write-only JSON ingest for the Proactive Scout. Was a standalone service
// (local/scout-ingest/); folded into this app's own process/port so there's
// one thing to run and one place Caddy points at, not two.
const SCOUT_SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function scoutHashToken(t) { return crypto.createHash('sha256').update(String(t)).digest(); }
const SCOUT_TOKEN_HASH = SCOUT_INGEST_TOKEN ? scoutHashToken(SCOUT_INGEST_TOKEN) : null;
function scoutIsValidToken(candidate) {
  if (!candidate || !SCOUT_TOKEN_HASH) return false;
  return crypto.timingSafeEqual(scoutHashToken(candidate), SCOUT_TOKEN_HASH);
}
function scoutLogLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  console.log('[scout-ingest]', line);
  fs.appendFile(SCOUT_INGEST_LOG_FILE, line + '\n', () => {}); // best-effort
}
function scoutPad2(n) { return String(n).padStart(2, '0'); }

// "Directory Watcher" step: extracts SEC filing entries out of an ingested
// sec_edgar/filing_batch record and flattens them into scout_sec_filings.
// Called inline right after a successful ingest write — the ingest route is
// already the only writer to that directory, so there's no separate
// polling/fs-watch process needed to "detect" a new payload.
const stmtInsertSecFiling = db.prepare(`
  INSERT OR IGNORE INTO scout_sec_filings
    (ticker, accession_number, entity_name, form_type, filed_at, description, filing_url, ingest_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
function extractSecFilingsFromRecord(record) {
  if (record.source !== 'sec_edgar' || record.kind !== 'filing_batch') return 0;
  const filings = record.payload?.filings;
  if (!Array.isArray(filings)) return 0;
  let inserted = 0;
  for (const f of filings) {
    if (!f || typeof f !== 'object' || !f.accession_number) continue;
    const info = stmtInsertSecFiling.run(
      f.ticker || null, f.accession_number, f.entity_name || null, f.form_type || null,
      f.filed_at || null, f.description || '', f.filing_url || null, record.id,
    );
    if (info.changes) inserted++;
  }
  return inserted;
}

// Backfill: walk scout-ingest/raw for any sec_edgar/filing_batch files not
// yet reflected in scout_sec_filings (accession_number UNIQUE makes this
// idempotent — safe to re-run). Catches anything ingested before this table
// existed, or written by some means other than the ingest route.
function backfillSecFilings() {
  if (!fs.existsSync(SCOUT_INGEST_RAW_DIR)) return;
  let filesScanned = 0, filingsInserted = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.json') || !full.includes(`${path.sep}sec_edgar${path.sep}filing_batch${path.sep}`)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(full, 'utf8'));
        filesScanned++;
        filingsInserted += extractSecFilingsFromRecord(record);
      } catch (e) { console.warn('[scout-ingest] backfill: failed to read', full, e.message); }
    }
  };
  walk(SCOUT_INGEST_RAW_DIR);
  if (filesScanned) console.log(`[scout-ingest] backfill: scanned ${filesScanned} sec_edgar file(s), inserted ${filingsInserted} new filing row(s)`);
}
backfillSecFilings();

// ── SEC filing fetch-on-add: closes the gap between the watchlist and the
//    SEC scraper (local/sec_scraper.py + GitHub Actions), which are otherwise
//    two disconnected systems — adding a ticker here never used to trigger
//    a fetch for it at all. Node port of sec_scraper.py's ticker->CIK->
//    submissions logic (same endpoints, same filtering), run inline instead
//    of waiting on a separate GitHub Actions run. ───────────────────────────
const SEC_FORM_TYPES = new Set(['8-K', '10-K', '10-Q', '20-F', '6-K']); // 20-F/6-K: foreign private issuer equivalents of 10-K/10-Q
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'TG-Capital-ProactiveScout/1.0 contact@osflex.me';
let secTickerMapCache = null; // { at: <ms>, map: { TICKER: {cik, title} } }
const SEC_TICKER_MAP_TTL_MS = 24 * 60 * 60 * 1000; // SEC's ticker list changes rarely

async function fetchSecTickerMap() {
  if (secTickerMapCache && (Date.now() - secTickerMapCache.at) < SEC_TICKER_MAP_TTL_MS) {
    return secTickerMapCache.map;
  }
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': SEC_USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`SEC ticker map fetch failed: ${r.status}`);
  const raw = await r.json();
  const map = {};
  for (const entry of Object.values(raw)) {
    map[String(entry.ticker).toUpperCase()] = { cik: String(entry.cik_str), title: entry.title };
  }
  secTickerMapCache = { at: Date.now(), map };
  return map;
}

// US, major-exchange-listed, no OTC — company_tickers_exchange.json (unlike
// company_tickers.json above) carries an `exchange` field. Verified against
// the live file: values are 'Nasdaq' | 'NYSE' | 'OTC' | 'CBOE' | null — OTC
// and null (foreign private issuers, debt-only filers, etc. with no US common-
// stock listing) are exactly what "no OTC tickers" per explicit user
// requirement means to exclude.
const TICKER_UNIVERSE_EXCHANGES = new Set(['Nasdaq', 'NYSE', 'CBOE']);
const TICKER_UNIVERSE_SYNC_INTERVAL_DAYS = 7; // this file changes rarely (new listings/delistings)
const stmtUpsertUniverseTicker = db.prepare(`
  INSERT INTO scout_ticker_universe (cik, ticker, name, exchange, synced_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(cik) DO UPDATE SET ticker = excluded.ticker, name = excluded.name,
    exchange = excluded.exchange, synced_at = excluded.synced_at
`);
async function syncTickerUniverse({ force = false } = {}) {
  if (!force) {
    const last = db.prepare(`SELECT MAX(synced_at) AS t FROM scout_ticker_universe`).get()?.t;
    if (last && (Date.now() - new Date(last + 'Z').getTime()) < TICKER_UNIVERSE_SYNC_INTERVAL_DAYS * 86400000) {
      return { synced: false, reason: 'fresh' };
    }
  }
  const r = await fetch('https://www.sec.gov/files/company_tickers_exchange.json', {
    headers: { 'User-Agent': SEC_USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Ticker universe fetch failed: ${r.status}`);
  const { fields, data } = await r.json();
  const cikIdx = fields.indexOf('cik'), tickerIdx = fields.indexOf('ticker'),
        nameIdx = fields.indexOf('name'), exchIdx = fields.indexOf('exchange');
  let upserted = 0;
  const upsertAll = db.transaction((rows) => {
    for (const row of rows) {
      if (!TICKER_UNIVERSE_EXCHANGES.has(row[exchIdx])) continue;
      stmtUpsertUniverseTicker.run(row[cikIdx], String(row[tickerIdx]).toUpperCase(), row[nameIdx], row[exchIdx]);
      upserted++;
    }
  });
  upsertAll(data);
  scoutLogLine({ event: 'ticker_universe_synced', total: data.length, kept: upserted });
  return { synced: true, total: data.length, kept: upserted };
}

// Per explicit user requirement: trim the universe to liquid-enough-to-trade
// names, not every non-OTC filer regardless of size — raised from an initial
// 500k to 1M, then back down to 500k once sentiment (not sector) became the
// primary quality signal. NULL (not yet checked) still passes — treated as
// "unknown," not "illiquid," so a ticker isn't silently excluded from the
// firehose during the brief window before its first volume check completes;
// ingestUniverseFilingsFromDailyIndex, the recent-filings dashboard endpoint,
// and sendConsolidatedMaterialAlert all apply this same floor.
const UNIVERSE_MIN_AVG_VOLUME = 500000;
const UNIVERSE_VOLUME_SYNC_INTERVAL_DAYS = 1; // volume moves daily, unlike exchange listing/sector
// Schwab's /quotes batch endpoint (confirmed live: 200 symbols/call succeeds
// cleanly) is dramatically cheaper than Finnhub's 1-symbol-per-1.1s throttle
// used for sector — the whole ~7,700-ticker universe fits in ~40 batched
// calls, fast enough to run to completion in a single discovery-loop tick
// rather than needing refreshUniverseSectorCache's bounded-batch/resume-over-
// many-ticks approach.
const SCHWAB_QUOTE_BATCH_SIZE = 150; // headroom under the 200 that was tested
async function refreshUniverseVolume() {
  const cutoff = new Date(Date.now() - UNIVERSE_VOLUME_SYNC_INTERVAL_DAYS * 86400000).toISOString();
  const symbols = db.prepare(`
    SELECT ticker FROM scout_ticker_universe
    WHERE volume_synced_at IS NULL OR volume_synced_at < ?
  `).all(cutoff).map(r => r.ticker);
  if (!symbols.length) return { checked: 0, updated: 0 };

  const stmtUpdateVolume = db.prepare(`UPDATE scout_ticker_universe SET avg_volume = ?, volume_synced_at = datetime('now') WHERE ticker = ?`);
  let updated = 0;
  for (let i = 0; i < symbols.length; i += SCHWAB_QUOTE_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SCHWAB_QUOTE_BATCH_SIZE);
    // fundamental.avg10DaysVolume, NOT quote.totalVolume — confirmed live that
    // totalVolume is today's live-accumulating session volume, which reads as
    // 0 for a real, heavily-traded name (EA) when checked after-hours (its
    // accumulator hadn't started for the "current" session yet). That would
    // have silently misclassified genuinely liquid names as illiquid any time
    // this sync happened to run outside market hours — avg10DaysVolume is a
    // real trailing average, not a same-day snapshot, so it doesn't have that
    // problem.
    const data = await schwabMarket('/quotes', { symbols: batch.join(','), fields: 'fundamental' });
    if (data.error) { scoutLogLine({ event: 'universe_volume_batch_failed', error: data.error }); continue; }
    for (const sym of batch) {
      const vol = data[sym]?.fundamental?.avg10DaysVolume;
      if (vol != null) { stmtUpdateVolume.run(Math.round(vol), sym); updated++; }
    }
  }
  scoutLogLine({ event: 'universe_volume_synced', checked: symbols.length, updated });
  return { checked: symbols.length, updated };
}

// Every filing of any form type SEC received on `day` (a Date) — the daily-
// index file, not a per-CIK loop. One request covers every filer, which is
// the only way market-wide 8-K coverage is actually affordable (looping
// scout_ticker_universe's ~7,700 tickers through the per-CIK submissions API
// the watchlist path uses would take tens of minutes per pass). Returns null
// if there's no index for that day yet (confirmed live: SEC's Archives path
// returns 403, not 404, for a not-yet-published/nonexistent daily index —
// both are treated as "no index," caller falls back further back).
async function fetchEdgarDailyIndexText(day) {
  const quarter = Math.floor(day.getUTCMonth() / 3) + 1;
  const yyyymmdd = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}`;
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${day.getUTCFullYear()}/QTR${quarter}/form.${yyyymmdd}.idx`;
  const r = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`EDGAR daily index fetch failed: ${r.status}`);
  return r.text();
}

// The .idx header is two visually-stacked lines that do NOT share a column
// frame with the data rows (confirmed against a real file — naive fixed-offset
// slicing cut "20260814" into "2026081"/"4"). Anchoring on each field's actual
// shape — 12-char form type, then name, numeric CIK, 8-digit date, file path —
// is robust regardless of company-name length; same approach as
// edgar_8k_price_filter.py's _parse_8k_rows.
const EDGAR_IDX_ROW_RE = /^(.{12})(.*?)\s+(\d+)\s+(\d{8})\s+(\S+)\s*$/;
function parseEightKIndexRows(indexText) {
  const rows = [];
  for (const line of indexText.split('\n')) {
    const m = EDGAR_IDX_ROW_RE.exec(line);
    if (!m) continue;
    const formType = m[1].trim();
    if (formType !== '8-K' && formType !== '8-K/A') continue;
    // Matches the "${filedAt}T00:00:00Z" convention fetchSecFilingsForTicker
    // already uses — filed_at is compared/sorted as a string elsewhere
    // (analyzeAndStorePending8Ks's date-range filter, digest ORDER BY), so a
    // format mismatch here would silently break those, not just display.
    const raw = m[4]; // YYYYMMDD
    const filedAt = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
    rows.push({ form_type: formType, entity_name: m[2].trim(), cik: Number(m[3]), filed_at: filedAt, filing_url: `https://www.sec.gov/Archives/${m[5]}` });
  }
  return rows;
}

// Firehose ingest: every 8-K filed market-wide today, walking back up to a
// week if today's index isn't published yet — confirmed live that a single
// day isn't enough (Monday's fallback of "yesterday" lands on Sunday, which
// also has no index; needs to walk back to Friday). Matched against
// scout_ticker_universe and stored into scout_sec_filings exactly like the
// watchlist's per-ticker fetch does — same table, same downstream rendering
// on Scout/osterm.html. Deliberately excludes tickers already on
// scout_watchlist: those keep going through fetchAndStoreSecFilingsForNewTicker
// unchanged (it also pulls insider Form 4 data the daily index doesn't have).
async function ingestUniverseFilingsFromDailyIndex() {
  const MAX_LOOKBACK_DAYS = 7;
  let text = null, daysBack = 0;
  for (; daysBack <= MAX_LOOKBACK_DAYS; daysBack++) {
    text = await fetchEdgarDailyIndexText(new Date(Date.now() - daysBack * 86400000));
    if (text != null) break;
  }
  if (text == null) return { fetched: 0, inserted: 0, reason: 'no_index_available_in_lookback_window' };

  const rows = parseEightKIndexRows(text);
  const universe = new Map(db.prepare(`
    SELECT cik, ticker FROM scout_ticker_universe
    WHERE ticker NOT IN (SELECT ticker FROM scout_watchlist)
      AND (avg_volume IS NULL OR avg_volume >= ?)
  `).all(UNIVERSE_MIN_AVG_VOLUME).map(r => [r.cik, r.ticker]));

  let inserted = 0;
  for (const row of rows) {
    const ticker = universe.get(row.cik);
    if (!ticker) continue;
    const accessionMatch = row.filing_url.match(/\/([\d-]+)\.txt$/);
    if (!accessionMatch) continue;
    const info = stmtInsertSecFiling.run(ticker, accessionMatch[1], row.entity_name, row.form_type, row.filed_at, null, row.filing_url, null);
    if (info.changes) inserted++;
  }
  scoutLogLine({ event: 'universe_firehose_ingest', daysBack, fetched: rows.length, inserted });
  return { fetched: rows.length, inserted };
}

async function fetchSecFilingsForTicker(ticker, startDateISO, endDateISO) {
  const tickerMap = await fetchSecTickerMap();
  const entry = tickerMap[ticker.toUpperCase()];
  if (!entry) return { found: false, filings: [], insiderFilings: [] };

  const paddedCik = entry.cik.padStart(10, '0');
  const r = await fetch(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, {
    headers: { 'User-Agent': SEC_USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 404) return { found: true, filings: [], insiderFilings: [] };
  if (!r.ok) throw new Error(`SEC submissions fetch failed for ${ticker}: ${r.status}`);

  const recent = (await r.json())?.filings?.recent || {};
  const forms = recent.form || [], dates = recent.filingDate || [], accessions = recent.accessionNumber || [];
  const primaryDocs = recent.primaryDocument || [], descriptions = recent.primaryDocDescription || [];
  const cikInt = String(parseInt(entry.cik, 10));

  // Form 4 (Section 16 insider transactions) entries live in this SAME response —
  // collected here rather than via a second fetch/endpoint, straight from data
  // already in hand. Not added to `filings` (scout_sec_filings expects one row per
  // filing with a single form_type from SEC_FORM_TYPES; Form 4 goes to the separate
  // scout_insider_filings table instead, one row per transaction).
  const filings = [];
  const insiderFilings = [];
  for (let i = 0; i < forms.length; i++) {
    const filedAt = dates[i];
    if (!(filedAt >= startDateISO && filedAt <= endDateISO)) continue;
    const adsh = accessions[i];
    const adshNoDash = adsh.replace(/-/g, '');
    const primaryDoc = primaryDocs[i] || '';

    if (forms[i] === '4') {
      // primaryDocument is the XSLT-rendered viewer path (e.g. "xslF345X06/form4.xml")
      // — the raw XML this app actually parses sits at the accession root under just
      // the basename, confirmed against a real live filing during design.
      const rawXmlName = primaryDoc.split('/').pop() || 'form4.xml';
      insiderFilings.push({
        ticker: ticker.toUpperCase(), cik: cikInt, accession_number: adsh, form_type: forms[i],
        filed_at: `${filedAt}T00:00:00Z`,
        filing_url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${adshNoDash}/${rawXmlName}`,
      });
      continue;
    }

    if (!SEC_FORM_TYPES.has(forms[i])) continue;
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${adshNoDash}/${primaryDoc || adsh + '-index.htm'}`;
    filings.push({
      ticker: ticker.toUpperCase(), accession_number: adsh, entity_name: entry.title,
      form_type: forms[i], filed_at: `${filedAt}T00:00:00Z`,
      description: descriptions[i] || '', filing_url: filingUrl,
    });
  }
  return { found: true, filings, insiderFilings };
}

// ── Insider trading (Form 4) — regex tag extraction, matching this file's existing
// convention for 8-K parsing (extract8KItemNumbers/extract8KBody) — no XML parser
// dependency for something this simple/flat/predictable (confirmed against a real
// live Form 4 during design). Handles both bare tags (<isOfficer>true</isOfficer>)
// and value-wrapped ones (<transactionShares><value>1439</value></transactionShares>)
// via the same helper, since Form 4's schema mixes both without a documented rule for
// which is which.
const TRANSACTION_CODE_LABELS = {
  P: 'Open market purchase', S: 'Open market sale', A: 'Grant/Award', D: 'Disposition to issuer',
  F: 'Tax withholding', M: 'Option exercise', C: 'Conversion', G: 'Gift', X: 'In-the-money option exercise',
  I: 'Discretionary transaction', J: 'Other', K: 'Equity swap', U: 'Tender offer disposition',
  W: 'Acquisition/disposition by will or descent', Z: 'Deposit/withdrawal (voting trust)',
};
function decodeXmlEntities(s) {
  if (s == null) return s;
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}
function extractXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}
function extractXmlValueTag(xml, tag) {
  const block = extractXmlTag(xml, tag);
  if (block == null) return null;
  const nested = extractXmlTag(block, 'value');
  return nested !== null ? nested : (block || null);
}
function extractAllXmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function parseForm4TransactionBlock(block, isDerivative) {
  const code = extractXmlValueTag(block, 'transactionCode');
  const shares = parseFloat(extractXmlValueTag(block, 'transactionShares'));
  const price = parseFloat(extractXmlValueTag(block, 'transactionPricePerShare'));
  const following = parseFloat(extractXmlValueTag(block, 'sharesOwnedFollowingTransaction'));
  return {
    transactionDate: extractXmlValueTag(block, 'transactionDate'),
    transactionCode: code,
    transactionCodeLabel: TRANSACTION_CODE_LABELS[code] || code || null,
    shares: Number.isFinite(shares) ? shares : null,
    pricePerShare: Number.isFinite(price) ? price : null,
    acquiredDisposedCode: extractXmlValueTag(block, 'transactionAcquiredDisposedCode'),
    sharesOwnedFollowing: Number.isFinite(following) ? following : null,
    isDerivative,
  };
}
function parseForm4Xml(xmlText) {
  const periodOfReport = extractXmlTag(xmlText, 'periodOfReport');
  const ownerBlock = extractXmlTag(xmlText, 'reportingOwner') || xmlText;
  const relBlock = extractXmlTag(ownerBlock, 'reportingOwnerRelationship') || ownerBlock;
  const boolTag = (b, t) => { const v = extractXmlTag(b, t); return v === 'true' || v === '1'; };
  const owner = {
    name: extractXmlTag(ownerBlock, 'rptOwnerName'),
    isOfficer: boolTag(relBlock, 'isOfficer'),
    isDirector: boolTag(relBlock, 'isDirector'),
    isTenPctOwner: boolTag(relBlock, 'isTenPercentOwner'),
    title: extractXmlTag(relBlock, 'officerTitle'),
  };
  const transactions = [
    ...extractAllXmlBlocks(xmlText, 'nonDerivativeTransaction').map(b => parseForm4TransactionBlock(b, false)),
    ...extractAllXmlBlocks(xmlText, 'derivativeTransaction').map(b => parseForm4TransactionBlock(b, true)),
  ];
  return { owner, transactions, periodOfReport };
}

const stmtInsertInsiderFiling = db.prepare(`
  INSERT OR IGNORE INTO scout_insider_filings
    (ticker, cik, accession_number, form_type, filed_at, period_of_report,
     owner_name, owner_is_officer, owner_is_director, owner_is_ten_pct_owner, owner_title,
     transaction_date, transaction_code, transaction_code_label, shares, price_per_share,
     acquired_disposed_code, shares_owned_following, is_derivative, filing_url)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Only fetches accessions not already parsed (checked before the network call) — the
// "minimal redundant retrieval" requirement: a ticker re-refreshed repeatedly never
// re-fetches/re-parses a Form 4 it already has rows for.
async function fetchAndStoreInsiderFilings(ticker, insiderMeta) {
  let fetched = 0, inserted = 0;
  for (const meta of insiderMeta) {
    const already = db.prepare(`SELECT 1 FROM scout_insider_filings WHERE accession_number = ? LIMIT 1`).get(meta.accession_number);
    if (already) continue;
    try {
      const r = await fetch(meta.filing_url, { headers: { 'User-Agent': SEC_USER_AGENT }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const xml = await r.text();
      const { owner, transactions, periodOfReport } = parseForm4Xml(xml);
      fetched++;
      for (const t of transactions) {
        const info = stmtInsertInsiderFiling.run(
          meta.ticker, meta.cik, meta.accession_number, meta.form_type, meta.filed_at, periodOfReport,
          owner.name, owner.isOfficer ? 1 : 0, owner.isDirector ? 1 : 0, owner.isTenPctOwner ? 1 : 0, owner.title,
          t.transactionDate, t.transactionCode, t.transactionCodeLabel, t.shares, t.pricePerShare,
          t.acquiredDisposedCode, t.sharesOwnedFollowing, t.isDerivative ? 1 : 0, meta.filing_url,
        );
        if (info.changes) inserted++;
      }
    } catch (e) {
      scoutLogLine({ event: 'insider_fetch_failed', ticker, accession: meta.accession_number, error: e.message });
    }
  }
  if (fetched) scoutLogLine({ event: 'insider_fetch', ticker, filingsFetched: fetched, transactionsInserted: inserted });
  return { fetched, inserted };
}

// Fire-and-forget from the watchlist route — best effort, logs outcome, never
// blocks or fails the add-ticker request. 450 days back covers the last 10-K
// (annual) plus the last few 10-Qs/8-Ks for any real company.
// Also doubles as the manual refresh mechanism (POST /api/scout/sec-filings/refresh)
// since it always re-fetches unconditionally — INSERT OR IGNORE on the unique
// accession_number makes re-running it for a ticker that already has filings safe and
// idempotent, only ever adding genuinely new ones since the last run.
async function fetchAndStoreSecFilingsForNewTicker(ticker) {
  try {
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 450 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { found, filings, insiderFilings } = await fetchSecFilingsForTicker(ticker, start, end);
    if (!found) {
      scoutLogLine({ event: 'sec_fetch_on_add', ticker, result: 'not_found_in_sec_ticker_map' });
      return { ok: false, ticker, reason: 'not_found_in_sec_ticker_map' };
    }
    let inserted = 0;
    for (const f of filings) {
      const info = stmtInsertSecFiling.run(
        f.ticker, f.accession_number, f.entity_name, f.form_type, f.filed_at, f.description, f.filing_url, null,
      );
      if (info.changes) inserted++;
    }
    const insiderResult = insiderFilings.length ? await fetchAndStoreInsiderFilings(ticker, insiderFilings) : { fetched: 0, inserted: 0 };
    scoutLogLine({ event: 'sec_fetch_on_add', ticker, fetched: filings.length, inserted, insiderFetched: insiderResult.fetched, insiderInserted: insiderResult.inserted });
    return { ok: true, ticker, fetched: filings.length, inserted, insider: insiderResult };
  } catch (e) {
    scoutLogLine({ event: 'sec_fetch_on_add', ticker, error: e.message });
    return { ok: false, ticker, reason: e.message };
  }
}

// Discovers tickers that newly registered a class of securities on EDGAR (Form
// 8-A12B — "Registration of Securities Pursuant to Section 12(b)") within the last
// N days. This is a genuinely different signal from everything else in this file:
// every other SEC function here fetches filings for tickers already on the
// watchlist; this one finds tickers NOT yet known about at all, via EDGAR's
// full-text-search API (efts.sec.gov) rather than the per-company submissions API
// (which requires already knowing a CIK). 8-A12B is the closest single-form proxy
// for "a new tradable ticker just went live" — it's what a company/SPAC/ETF files
// to actually list a class of securities on an exchange — but it's a proxy, not a
// perfect filter: the same form also gets filed by long-listed issuers adding a new
// preferred/warrant class (multi-ticker display_names, filtered out below) and by ETF
// trusts registering a new share class (no parenthesized ticker at all, also filtered
// out below since this app is ticker-centric). What's left after those two filters
// skews toward genuine new listings (SPAC IPOs, uplistings, new common stock) but can
// still include a re-registration by an already-public single-ticker company —
// treat the result as "worth a look," not a verified new-IPO list.
async function discoverNewEdgarTickers(days = 7) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22%22&forms=8-A12B&startdt=${fmt(start)}&enddt=${fmt(end)}`;

  const r = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`EDGAR full-text search failed: ${r.status}`);
  const data = await r.json();
  const hits = data?.hits?.hits || [];

  const already = new Set(db.prepare(`SELECT ticker FROM scout_watchlist`).all().map(r => r.ticker));
  const byTicker = new Map(); // dedupe to the most recent filing per ticker
  for (const h of hits) {
    const s = h._source || {};
    const name = (s.display_names || [])[0] || '';
    const m = name.match(/\(([A-Z]{1,6}(?:\.[A-Z])?)\)\s*\(CIK/); // single clean ticker only — see comment above
    if (!m) continue;
    const ticker = m[1];
    const filedAt = s.file_date || '';
    const existing = byTicker.get(ticker);
    if (existing && existing.filed_at >= filedAt) continue;
    byTicker.set(ticker, {
      ticker,
      company: name.replace(/\s*\([A-Z.]+\)\s*\(CIK[^)]*\)\s*$/, '').trim(),
      cik: (s.ciks || [])[0] || null,
      form_type: s.form || '8-A12B',
      filed_at: filedAt,
      accession_number: s.adsh || null,
      already_tracked: already.has(ticker),
    });
  }
  return [...byTicker.values()].sort((a, b) => b.filed_at.localeCompare(a.filed_at));
}

// On-demand equivalent of the GitHub Actions SEC scraper (local/sec_scraper.py
// + .github/workflows/sec-scraper.yml), for callers that need filings on file
// RIGHT NOW rather than waiting on the next scheduled run or a manual
// workflow_dispatch. Only hits EDGAR if this ticker has zero rows on file —
// cheap to call on every Truth Check without re-fetching tickers that already
// have data (a stale existing filing is still a real filing; this isn't a
// freshness poll, just a "don't run Truth Check on nothing" guard).
async function ensureSecFilingsOnFile(ticker) {
  const existing = db.prepare('SELECT COUNT(*) as n FROM scout_sec_filings WHERE ticker = ?').get(ticker).n;
  if (existing > 0) return { fetched: false, inserted: 0 };

  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 450 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { found, filings } = await fetchSecFilingsForTicker(ticker, start, end);
  if (!found) { scoutLogLine({ event: 'sec_fetch_on_demand', ticker, result: 'not_found_in_sec_ticker_map' }); return { fetched: true, inserted: 0 }; }

  let inserted = 0;
  for (const f of filings) {
    const info = stmtInsertSecFiling.run(
      f.ticker, f.accession_number, f.entity_name, f.form_type, f.filed_at, f.description, f.filing_url, null,
    );
    if (info.changes) inserted++;
  }
  scoutLogLine({ event: 'sec_fetch_on_demand', ticker, fetched: filings.length, inserted });
  return { fetched: true, inserted };
}

app.post('/api/v1/ingest', (req, res) => {
  if (!SCOUT_INGEST_TOKEN) {
    return res.status(503).json({ error: 'not_configured', message: 'SCOUT_INGEST_TOKEN is not set on the server.' });
  }
  const remoteIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !scoutIsValidToken(token)) {
    scoutLogLine({ event: 'auth_failed', remote_ip: remoteIp });
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid bearer token.' });
  }

  const body = req.body || {};
  const { source, kind, payload } = body;
  let { created_at, metadata } = body;

  const errors = [];
  if (typeof source !== 'string' || !SCOUT_SAFE_SEGMENT.test(source)) {
    errors.push('source must be a string matching ^[a-z0-9][a-z0-9_-]{0,63}$ (letters, digits, "_", "-" only).');
  }
  if (typeof kind !== 'string' || !SCOUT_SAFE_SEGMENT.test(kind)) {
    errors.push('kind must be a string matching ^[a-z0-9][a-z0-9_-]{0,63}$ (letters, digits, "_", "-" only).');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    errors.push('payload is required and must be a JSON object.');
  }
  if (metadata === undefined || metadata === null) {
    metadata = {};
  } else if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    errors.push('metadata, if present, must be a JSON object.');
  }
  if (created_at !== undefined && created_at !== null) {
    const parsed = new Date(created_at);
    if (typeof created_at !== 'string' || Number.isNaN(parsed.getTime())) {
      errors.push('created_at, if present, must be a valid ISO8601 timestamp string.');
    }
  }
  if (errors.length) {
    scoutLogLine({ event: 'validation_failed', remote_ip: remoteIp, source: source ?? null, kind: kind ?? null, errors });
    return res.status(400).json({ error: 'invalid_body', message: 'Request body failed validation.', details: errors });
  }

  const id = crypto.randomUUID();
  const serverReceivedAt = new Date();
  const serverReceivedAtIso = serverReceivedAt.toISOString();
  const finalCreatedAt = created_at ? new Date(created_at).toISOString() : serverReceivedAtIso;
  const record = { id, source, kind, created_at: finalCreatedAt, server_received_at: serverReceivedAtIso, payload, metadata };

  const y = serverReceivedAt.getUTCFullYear();
  const m = scoutPad2(serverReceivedAt.getUTCMonth() + 1);
  const d = scoutPad2(serverReceivedAt.getUTCDate());
  const dirRel = path.join(String(y), m, d, source, kind);
  const dirAbs = path.join(SCOUT_INGEST_RAW_DIR, dirRel);
  const fileName = `${y}${m}${d}_${source}_${kind}_${id}.json`;
  const fileRel = path.join('scout-ingest', 'raw', dirRel, fileName);
  const fileAbs = path.join(dirAbs, fileName);

  try {
    fs.mkdirSync(dirAbs, { recursive: true });
    fs.writeFileSync(fileAbs, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(SCOUT_INGEST_LAST_ID, id, 'utf8');
  } catch (e) {
    scoutLogLine({ event: 'write_failed', remote_ip: remoteIp, source, kind, id, error: e.message });
    return res.status(500).json({ error: 'storage_failed', message: 'Could not persist the record.' });
  }

  let filingsExtracted = 0;
  try {
    filingsExtracted = extractSecFilingsFromRecord(record);
  } catch (e) {
    scoutLogLine({ event: 'extract_failed', remote_ip: remoteIp, source, kind, id, error: e.message });
    // Extraction failure doesn't fail the ingest itself — the raw file is
    // already safely on disk and backfillSecFilings() will pick it up later.
  }

  scoutLogLine({ event: 'ingested', remote_ip: remoteIp, source, kind, id, path: fileRel, filings_extracted: filingsExtracted });
  res.status(201).json({ id, status: 'ingested', stored_path: fileRel, server_received_at: serverReceivedAtIso, filings_extracted: filingsExtracted });
});

// ── API: status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const tokens  = loadTokens();
  const hasData = fs.existsSync(CSV_FILE);
  const csvSize = hasData ? (fs.statSync(CSV_FILE).size / 1024).toFixed(1) + ' KB' : null;
  const dbTotal = db.prepare('SELECT COUNT(*) as n FROM trades').get().n;
  res.json({ ...syncStatus, authed: isTokenValid(tokens), hasData, csvSize, dbTotal });
});

// ── API: trigger sync ─────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  if (syncStatus.running) return res.json({ ok: false, reason: 'already running' });
  const { days, startDate, endDate } = req.body || {};
  const opts = startDate ? { startDate, endDate: endDate || new Date().toISOString().slice(0,10) }
                         : { days: parseInt(days || '90', 10) };
  runSync(opts).catch(() => {});
  res.json({ ok: true, ...opts });
});

// ── API: dashboard metrics ────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  try {
    const from   = req.query.from   || null;
    const to     = req.query.to     || null;
    const ticker = req.query.ticker || null;
    const data   = computeDashboard(from, to, ticker);

    // When a specific ticker is requested, also return its individual contracts
    let tickerContracts = null;
    if (ticker) {
      const safeTicker = ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');
      const conds = [`COALESCE(underlying, symbol) = '${safeTicker}'`, "asset_type = 'OPTION'"];
      if (from) conds.push(`date_iso >= '${from}'`);
      if (to)   conds.push(`date_iso <= '${to}'`);
      tickerContracts = db.prepare(`
        SELECT symbol,
               MIN(date_iso) as opened, MAX(date_iso) as closed,
               SUM(amount) as net_pnl,
               SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as proceeds,
               SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as cost_basis,
               SUM(fees) as fees,
               COUNT(*) as legs,
               GROUP_CONCAT(DISTINCT action) as actions,
               CAST(julianday(MAX(date_iso)) - julianday(MIN(date_iso)) AS INTEGER) as holding_days
        FROM trades WHERE ${conds.join(' AND ')}
        GROUP BY symbol ORDER BY MAX(date_iso) DESC
      `).all();
    }

    res.json({ ok: true, data, syncStatus, tickerContracts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: advanced analytics (wash sales, tax estimate, fees, losses, trends) ─
app.get('/api/analytics/advanced', (req, res) => {
  try {
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;
    const ticker = req.query.ticker || null;
    const federalRateST = Math.max(0, Math.min(1, Number(req.query.fedStRate ?? 0.32)));
    const federalRateLT = Math.max(0, Math.min(1, Number(req.query.fedLtRate ?? 0.15)));
    const stateRate = Math.max(0, Math.min(1, Number(req.query.stateRate ?? 0.05)));
    const projectionMonths = Math.max(1, Math.min(18, Number(req.query.projectionMonths ?? 6)));

    const data = computeAdvancedAnalytics({
      fromDate,
      toDate,
      ticker,
      federalRateST,
      federalRateLT,
      stateRate,
      projectionMonths,
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Performance Coach — year-over-year + seasonality ────────────────────
app.get('/api/analytics/seasonality', (req, res) => {
  try {
    const ticker = req.query.ticker || null;
    res.json({ ok: true, yoy: computeYoY(ticker), seasonality: computeSeasonality(ticker) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Performance Coach — sector P&L breakdown ─────────────────────────────
app.get('/api/analytics/sector', (req, res) => {
  try {
    const fromDate = req.query.from || null;
    const toDate   = req.query.to   || null;
    res.json({ ok: true, sectors: computeSectorBreakdown(fromDate, toDate), finnhubConfigured: !!FINNHUB_API_KEY });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Performance Coach — "why" trading-leak analysis ──────────────────────
app.get('/api/analytics/insights', (req, res) => {
  try {
    res.json({
      ok: true,
      winRateBySetup: tradingInsights.computeWinRateBySetup(db),
      holdingPeriod: tradingInsights.computeHoldingPeriodBreakdown(db),
      leaks: tradingInsights.generateLeakInsights(db),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Performance Coach — risk thermometer (margin/leverage gauge) ────────
app.get('/api/analytics/risk', async (req, res) => {
  try {
    const snapshot = await fetchLiveAccountSnapshot();
    const current = riskMetrics.computeMarginRatio(snapshot.balances);
    res.json({ ok: true, current, balances: snapshot.balances, history: riskMetrics.getRiskHistory(db, 30) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Performance Coach — portfolio Greeks, expiration/assignment risk,
//         and sector/ticker concentration, all from live open positions ─────
app.get('/api/analytics/portfolio-risk', async (req, res) => {
  try {
    const snapshot = await fetchLiveAccountSnapshot();
    const fetchChain = (underlying) => schwabMarket('/chains', { symbol: underlying, includeUnderlyingQuote: 'true' });
    const greeks = await portfolioRisk.computeGreeksAndExpiry(snapshot.positions, fetchChain);

    const sectorRows = db.prepare('SELECT symbol, sector FROM sector_cache').all();
    const sectorBySymbol = Object.fromEntries(sectorRows.map(r => [r.symbol, r.sector]));
    const concentration = portfolioRisk.computeConcentration(snapshot.positions, sectorBySymbol);

    res.json({ ok: true, ...greeks, concentration });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Performance Coach — benchmark vs. SPY buy-and-hold ──────────────────
app.get('/api/analytics/benchmark', async (req, res) => {
  try {
    const fromDate = req.query.from || null;
    const toDate   = req.query.to   || null;
    res.json({ ok: true, ...(await computeBenchmarkComparison(fromDate, toDate)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Shared by /api/trade-ideas/generate and generateStockVerdict() — everything
// tradeIdeas.js's digest builder needs from server.js, by reference. Factored
// out once both call sites needed the identical object.
function buildTradeIdeaHelpers() {
  return {
    db, schwabMarket, fetchLiveAccountSnapshot, buildTradingStyleProfile,
    computeDashboard, ragSearch: (q, topN) => rag.search(db, q, OLLAMA_HOST, EMBED_MODEL, topN),
    trendDirection: _trendDirection, supportResistance: _supportResistance,
    ivRankProxy: _ivRankProxy, normalizeIvPct: _normalizeIvPct,
    nearestByDelta: _nearestByDelta, chainLiquidityScore: _chainLiquidityScore,
    pickExpiry: _pickExpiry, flattenChain: _flattenChain,
    ollamaHost: OLLAMA_HOST, chatModel: CHAT_MODEL, ollamaTimeoutMs: OLLAMA_CHAT_TIMEOUT_MS,
  };
}

// ── Stock Verdict — "trade, invest, or pass" ──────────────────────────────────
// One synthesis call combining tradeIdeas.js's financial/technical digest
// (price, trend, support/resistance, IV rank, RSI/MACD/ATR, option-chain
// quality, the trader's own history on this ticker) with everything Proactive
// Scout already has on file (SEC filings, insider Form 4s, Finnhub news,
// crawled sentiment, Truth Check verdict — via the same toolGetTruthCheck used
// by Plutus's get_truth_check tool, so this reads the identical trust-tiered
// data rather than a second copy of the logic). Deterministic-trigger, not
// model-tool-choice — same reasoning as every other short-circuit in this file.
const VERDICT_SYSTEM_PROMPT = [
  'You are Plutus, evaluating whether a stock is worth trading, investing in, or passing on right now.',
  'Use ONLY the real data provided below — every figure is already computed; do not invent, recompute, or round-trip a number that is not present.',
  'If a whole section is missing (financials unavailable, no Scout data on file), say so and weight the verdict on what IS available rather than guessing the rest.',
  '',
  'Respond with ONLY a JSON object matching this exact shape:',
  '{',
  '  "verdict": "trade" | "invest" | "pass",',
  '  "score": a number from 0 to 100 (higher = more favorable),',
  '  "summary": "2-3 plain-English sentences naming the strongest evidence for this verdict",',
  '  "reasons": ["3-6 short bullets, each citing a specific figure or fact from the data given"],',
  '  "caution": "one sentence naming the single biggest risk or reason to hesitate, or null if genuinely none"',
  '}',
  '',
  '"trade" = a favorable near-term tactical setup (technicals/momentum support it now).',
  '"invest" = better fit as a longer-horizon position (fundamentals/filings are solid but there is no near-term technical edge).',
  '"pass" = neither — real red flags (from Truth Check, dilution risk, insider selling, weak technicals) or just not enough edge either way.',
  'This is decision support for the trader\'s own manual review, not financial advice — do not phrase the summary as a directive.',
].join('\n');

async function generateStockVerdict(ticker) {
  ticker = String(ticker || '').trim().toUpperCase();
  if (!ticker) throw new Error('ticker is required');

  const [tradeDigest, scoutResult] = await Promise.all([
    tradeIdeas._buildTickerDigest(ticker, buildTradeIdeaHelpers()).catch(() => null),
    Promise.resolve(toolGetTruthCheck(ticker)),
  ]);
  let quote = null;
  try { quote = await fetchQuoteAndProfile(ticker); } catch {}

  if (!tradeDigest && !scoutResult.ok && !quote) {
    throw new Error(`No financial or Proactive Scout data available for ${ticker} — nothing to evaluate.`);
  }

  const digest = {
    ticker,
    financials_and_technicals: tradeDigest || 'unavailable (needs 6mo of price history and a live quote)',
    quote: quote || 'unavailable',
    proactive_scout: scoutResult.ok ? scoutResult.data : `unavailable — ${scoutResult.reason}`,
  };

  // validate runs inside ollamaChatWithFallback's retry boundary — a malformed-JSON
  // 200 response (confirmed happening in practice on the Truth Check call this
  // function reuses data from — see runContradictionAnalysis's comment) counts as
  // a failure worth retrying on the fallback model, not just a non-OK HTTP status.
  const { parsed, modelUsed } = await ollamaChatWithFallback(CHAT_MODEL, CHAT_MODEL_FALLBACK, {
    messages: [
      { role: 'system', content: VERDICT_SYSTEM_PROMPT },
      { role: 'user', content: 'Data for ' + ticker + ':\n\n' + JSON.stringify(digest, null, 2) },
    ],
    format: 'json',
    stream: false,
    think: false,
    options: { temperature: 0.2, num_predict: 1024 },
  }, OLLAMA_CHAT_TIMEOUT_MS, (data) => {
    try {
      return JSON.parse(data.message?.content || data.message?.thinking || '{}');
    } catch (e) {
      throw new Error(`Model did not return valid JSON: ${e.message}`);
    }
  });
  const VERDICTS = ['trade', 'invest', 'pass'];
  const verdict = VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'pass';
  const score = Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null;
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 6) : [];

  const info = db.prepare(`
    INSERT INTO scout_verdicts (ticker, verdict, score, summary, reasons_json, caution, digest_json, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ticker, verdict, score, parsed.summary || '', JSON.stringify(reasons), parsed.caution || null, JSON.stringify(digest), modelUsed);

  return {
    id: info.lastInsertRowid, ticker, verdict, score, summary: parsed.summary || '',
    reasons, caution: parsed.caution || null, model_used: modelUsed, generated_at: new Date().toISOString(),
    quote, financials_and_technicals: tradeDigest,
  };
}

const VERDICT_FRESH_HOURS = 12;
app.post('/api/scout/verdict', async (req, res) => {
  try {
    const ticker = String(req.body?.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    if (!req.body?.force) {
      const recent = db.prepare(`SELECT * FROM scout_verdicts WHERE ticker = ? AND generated_at >= datetime('now', ?) ORDER BY generated_at DESC LIMIT 1`)
        .get(ticker, `-${VERDICT_FRESH_HOURS} hours`);
      if (recent) return res.json({ ok: true, cached: true, verdict: { ...recent, reasons: JSON.parse(recent.reasons_json || '[]') } });
    }
    const result = await generateStockVerdict(ticker);
    res.json({ ok: true, cached: false, verdict: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/scout/verdict', (req, res) => {
  try {
    const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : null;
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    const row = db.prepare(`SELECT * FROM scout_verdicts WHERE ticker = ? ORDER BY generated_at DESC LIMIT 1`).get(ticker);
    if (!row) return res.json({ ok: true, verdict: null });
    res.json({ ok: true, verdict: { ...row, reasons: JSON.parse(row.reasons_json || '[]') } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── API: Proactive Scout — trade-idea report generation (manual trigger) ─────
app.post('/api/trade-ideas/generate', async (req, res) => {
  try {
    const tickers = Array.isArray(req.body?.tickers) && req.body.tickers.length ? req.body.tickers : null;
    const result = await tradeIdeas.generateTradeIdeaReport({ tickers, trigger: 'manual' }, buildTradeIdeaHelpers());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Proactive Scout — list / fetch past trade-idea reports ──────────────
app.get('/api/trade-ideas', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, generated_at, trigger, tickers, emailed, email_error
      FROM trade_idea_reports ORDER BY generated_at DESC LIMIT 30
    `).all();
    res.json({ ok: true, reports: rows.map(r => ({ ...r, tickers: JSON.parse(r.tickers || '[]') })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/trade-ideas/:id', (req, res) => {
  try {
    const row = db.prepare(`SELECT * FROM trade_idea_reports WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Report not found' });
    res.json({ ok: true, report: { ...row, tickers: JSON.parse(row.tickers || '[]'), digest: JSON.parse(row.digest_json || '{}') } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: Proactive Scout — confluence-alert watchlist ─────────────────────────
app.get('/api/scout/watchlist', (req, res) => {
  try {
    const rows = db.prepare(`SELECT ticker, added_at, last_scanned_at FROM scout_watchlist ORDER BY ticker`).all();
    res.json({ ok: true, watchlist: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/scout/watchlist', (req, res) => {
  try {
    const ticker = String(req.body?.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    const info = db.prepare(`INSERT OR IGNORE INTO scout_watchlist (ticker) VALUES (?)`).run(ticker);
    const isNew = info.changes > 0;
    if (isNew) fetchAndStoreSecFilingsForNewTicker(ticker); // fire-and-forget, doesn't block the response
    res.json({ ok: true, sec_fetch_triggered: isNew });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Manual SEC filing refresh — the local, on-demand replacement for the GitHub Actions
// scraper's daily cron (which is now disabled; see .github/workflows/sec-scraper.yml).
// { ticker } refreshes one; omitted refreshes every watchlist ticker.
app.post('/api/scout/sec-filings/refresh', async (req, res) => {
  try {
    const ticker = req.body?.ticker ? String(req.body.ticker).trim().toUpperCase() : null;
    const tickers = Array.isArray(req.body?.tickers) && req.body.tickers.length
      ? req.body.tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean)
      : ticker
      ? [ticker]
      : db.prepare(`SELECT ticker FROM scout_watchlist ORDER BY ticker`).all().map(r => r.ticker);
    if (!tickers.length) return res.json({ ok: true, results: [] });

    const results = [];
    for (const t of tickers) {
      results.push(await fetchAndStoreSecFilingsForNewTicker(t));
      await new Promise(r => setTimeout(r, 300)); // light courtesy delay between EDGAR calls
    }
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// New-listing discovery — NOT tied to the watchlist, finds tickers not yet known
// about at all (see discoverNewEdgarTickers comment). ?days=7 default, ?days=14 etc.
app.get('/api/scout/edgar/new-tickers', async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const tickers = await discoverNewEdgarTickers(days);
    res.json({ ok: true, days, count: tickers.length, tickers });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Aggregates already-analyzed filings across every watchlist ticker — for the
// Sentiment Terminal's "Fresh Intel" feed, per-ticker 8-K card, and recent-hits table.
// Pure read against scout_sec_filings; triggers no new fetch or Llama analysis (unlike
// sec-filings/refresh). Optional ?ticker= narrows to one (still watchlist-only).
app.get('/api/scout/edgar/recent-filings', (req, res) => {
  try {
    const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 30));
    const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : null;
    // Watchlist filings as before, PLUS material, positive-sentiment,
    // Technology-sector ticker-universe filings for liquid-enough-to-trade
    // names (all four required together per explicit user requirement) —
    // everything else the firehose ingests stays DB-only, visible by
    // searching that specific ticker (which auto-onboards it onto the
    // watchlist, see onboardOrResumeTicker in osterm.html) rather than in
    // this glance feed. Mirrors sendConsolidatedMaterialAlert's own filter exactly, so
    // "shows on the dashboard" and "would trigger an email" agree with each
    // other for universe tickers.
    const rows = db.prepare(`
      SELECT ticker, form_type, filed_at, description, filing_url,
             llama_summary, llama_sentiment, llama_material_event,
             llama_catalyst, llama_bearish_signal, llama_confidence
      FROM scout_sec_filings
      WHERE filed_at >= datetime('now', ?)
        AND (
          ticker IN (SELECT ticker FROM scout_watchlist)
          OR (
            llama_material_event = 1
            AND llama_sentiment = 'positive'
            AND ticker IN (SELECT symbol FROM sector_cache WHERE sector = 'Technology')
            AND ticker IN (SELECT ticker FROM scout_ticker_universe WHERE avg_volume IS NULL OR avg_volume >= ?)
          )
        )
        ${ticker ? 'AND ticker = ?' : ''}
      ORDER BY filed_at DESC
      LIMIT 200
    `).all(...(ticker ? [`-${days} days`, UNIVERSE_MIN_AVG_VOLUME, ticker] : [`-${days} days`, UNIVERSE_MIN_AVG_VOLUME]));
    res.json({ ok: true, days, ticker, count: rows.length, filings: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/scout/insider', (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
    const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : null;
    const rows = db.prepare(`
      SELECT ticker, filed_at, period_of_report, owner_name, owner_is_officer, owner_is_director,
             owner_is_ten_pct_owner, owner_title, transaction_date, transaction_code,
             transaction_code_label, shares, price_per_share, acquired_disposed_code,
             shares_owned_following, is_derivative, filing_url
      FROM scout_insider_filings
      WHERE ticker IN (SELECT ticker FROM scout_watchlist)
        AND filed_at >= datetime('now', ?)
        ${ticker ? 'AND ticker = ?' : ''}
      ORDER BY transaction_date DESC
      LIMIT 200
    `).all(...(ticker ? [`-${days} days`, ticker] : [`-${days} days`]));
    res.json({ ok: true, days, ticker, count: rows.length, transactions: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Finnhub news — secondary/gap-fill source, deliberately never the alert trigger
// (SEC 8-K discovery owns that). Freshness-guarded like the sentiment crawl so a
// ticker page load doesn't re-hit Finnhub on every visit.
const NEWS_FRESH_HOURS = 6;
const stmtInsertNews = db.prepare(`
  INSERT OR IGNORE INTO scout_news (ticker, headline, summary, source, url, published_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
async function ensureNewsOnFile(ticker) {
  const recent = db.prepare(`SELECT 1 FROM scout_news WHERE ticker = ? AND fetched_at >= datetime('now', ?) LIMIT 1`)
    .get(ticker, `-${NEWS_FRESH_HOURS} hours`);
  if (recent) return;
  try {
    const items = await news.fetchFinnhubNews(ticker, FINNHUB_API_KEY, 7);
    if (items.skipped) return;
    for (const it of items) {
      stmtInsertNews.run(
        ticker, it.headline || '', it.summary || '', it.source || 'Finnhub', it.url || '',
        it.datetime ? new Date(it.datetime * 1000).toISOString() : null,
      );
    }
  } catch (e) { scoutLogLine({ event: 'news_fetch_failed', ticker, error: e.message }); }
}

app.get('/api/scout/news', async (req, res) => {
  try {
    const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : null;
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    await ensureNewsOnFile(ticker);
    const rows = db.prepare(`
      SELECT headline, summary, source, url, published_at FROM scout_news
      WHERE ticker = ? ORDER BY published_at DESC LIMIT 20
    `).all(ticker);
    res.json({ ok: true, ticker, finnhubConfigured: !!FINNHUB_API_KEY, items: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/scout/watchlist/:ticker', (req, res) => {
  try {
    db.prepare(`DELETE FROM scout_watchlist WHERE ticker = ?`).run(String(req.params.ticker).toUpperCase());
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── API: Proactive Scout — confluence alert scan (manual trigger) ────────────
// Scans every watchlist ticker for RSI/MACD/volume confluence (indicatorEngine.js)
// and records a new alert row for any ticker+direction that fires and doesn't
// already have an unacknowledged alert from today (avoids re-firing on every scan).
// Single-ticker confluence scan — factored out of the route below so the batch
// orchestrator (runFullAnalysis) can call it directly instead of looping HTTP
// requests against itself.
async function scanOneTicker(ticker) {
  const today = new Date().toISOString().slice(0, 10);
  let hData;
  try {
    hData = await schwabMarket('/pricehistory', { symbol: ticker, periodType: 'month', period: 6, frequencyType: 'daily', frequency: 1 });
  } catch (e) {
    return { ticker, error: e.message };
  }
  const confluence = indicatorEngine.computeConfluence(ticker, hData?.candles || []);
  // Set regardless of whether it fired — this is the only record that a scan
  // actually completed for this ticker, since confluence_alerts only ever gets
  // a row when something fires.
  db.prepare(`UPDATE scout_watchlist SET last_scanned_at = datetime('now') WHERE ticker = ?`).run(ticker);
  if (!confluence.fires) return { ticker, fired: false };

  const already = db.prepare(`
    SELECT id FROM confluence_alerts
    WHERE ticker = ? AND direction = ? AND acknowledged = 0 AND date(fired_at) = ?
  `).get(ticker, confluence.direction, today);
  if (already) return { ticker, fired: false, reason: 'already_alerted_today' };

  const info = db.prepare(`
    INSERT INTO confluence_alerts (ticker, direction, rsi14, macd_status, volume_ratio, signals_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ticker, confluence.direction, confluence.rsi14, confluence.macdCross, confluence.volumeSpike?.ratio ?? null, JSON.stringify(confluence.signals));
  return { id: info.lastInsertRowid, ticker, fired: true, direction: confluence.direction, signals: confluence.signals };
}

app.post('/api/scout/scan', async (req, res) => {
  try {
    // Optional scope: an explicit tickers[] group, a single ticker, or (if neither
    // is given) the whole watchlist — same three-tier convention as /api/scout/analyze.
    const reqTicker = req.body?.ticker ? String(req.body.ticker).trim().toUpperCase() : null;
    const tickers = Array.isArray(req.body?.tickers) && req.body.tickers.length
      ? req.body.tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean)
      : reqTicker
      ? [reqTicker]
      : db.prepare(`SELECT ticker FROM scout_watchlist ORDER BY ticker`).all().map(r => r.ticker);
    if (!tickers.length) return res.json({ ok: true, scanned: 0, fired: [] });

    const fired = [];
    for (const ticker of tickers) {
      const result = await scanOneTicker(ticker);
      if (result.error || result.fired) fired.push(result);
    }
    res.json({ ok: true, scanned: tickers.length, fired });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/scout/alerts', (req, res) => {
  try {
    const unackOnly = req.query.unacknowledged === '1';
    const rows = db.prepare(`
      SELECT * FROM confluence_alerts
      ${unackOnly ? 'WHERE acknowledged = 0' : ''}
      ORDER BY fired_at DESC LIMIT 100
    `).all();
    res.json({ ok: true, alerts: rows.map(r => ({ ...r, signals: JSON.parse(r.signals_json || '[]') })) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/scout/alerts/:id/ack', (req, res) => {
  try {
    db.prepare(`UPDATE confluence_alerts SET acknowledged = 1 WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── API: Proactive Scout — Sentiment Crawler (manual trigger) ────────────────
// Same watchlist as /api/scout/scan, same webSearch() the chat's web_search
// tool already uses — just a different query shape and a storage table
// instead of feeding straight into a chat reply.
const stmtInsertSentiment = db.prepare(`INSERT INTO scout_sentiment (ticker, query, content) VALUES (?, ?, ?)`);
// Single-ticker sentiment crawl — factored out for runFullAnalysis to call directly.
async function crawlSentimentForTicker(ticker) {
  const query = `${ticker} sentiment — restricted to: ${SENTIMENT_SOURCES.join(', ')}`;
  try {
    const content = await sentimentWebSearch(ticker);
    if (content) {
      const info = stmtInsertSentiment.run(ticker, query, content);
      return { ticker, id: info.lastInsertRowid, chars: content.length };
    }
    return { ticker, error: 'No results returned' };
  } catch (e) {
    return { ticker, error: e.message };
  }
}

app.post('/api/scout/sentiment/crawl', async (req, res) => {
  if (!OLLAMA_API_KEY && !PERPLEXITY_API_KEY) {
    return res.status(503).json({ ok: false, error: 'No search provider configured — set PERPLEXITY_API_KEY or OLLAMA_API_KEY.' });
  }
  try {
    const tickers = Array.isArray(req.body?.tickers) && req.body.tickers.length
      ? req.body.tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean)
      : db.prepare(`SELECT ticker FROM scout_watchlist ORDER BY ticker`).all().map(r => r.ticker);
    if (!tickers.length) return res.json({ ok: true, crawled: 0, results: [] });

    const results = [];
    for (let i = 0; i < tickers.length; i++) {
      results.push(await crawlSentimentForTicker(tickers[i]));
      if (i < tickers.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    res.json({ ok: true, crawled: results.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/scout/sentiment', (req, res) => {
  try {
    const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : null;
    const rows = db.prepare(`
      SELECT * FROM scout_sentiment
      ${ticker ? 'WHERE ticker = ?' : ''}
      ORDER BY fetched_at DESC LIMIT 100
    `).all(...(ticker ? [ticker] : []));
    res.json({ ok: true, sentiment: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── API: Proactive Scout — Contradiction Engine ───────────────────────────────
// Fetches the real filing document text (scout_sec_filings only stores
// metadata + a URL, not body text) and compares it against the most recent
// crawled sentiment for the same ticker via a small local Ollama model.
// ── SEC filing raw-HTML cache ──────────────────────────────────────────────────
// Caches the raw HTML on disk before parsing/extraction — avoids re-downloading the
// same filing from SEC on every Truth Check / 8-K analysis re-run within the TTL
// window. Eviction runs after every discovery-loop iteration (see runDiscoveryLoop),
// not on a separate timer/thread, per spec: expired files first, then oldest-by-mtime
// if still over the size cap.
const SEC_CACHE_DIR = path.join(DATA_DIR, 'sec-cache');
fs.mkdirSync(SEC_CACHE_DIR, { recursive: true });
const SEC_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const SEC_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function secCachePath(accessionNumber) {
  const safe = String(accessionNumber || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return safe ? path.join(SEC_CACHE_DIR, `${safe}.html`) : null;
}
function getCachedFilingHtml(accessionNumber) {
  const p = secCachePath(accessionNumber);
  if (!p) return null;
  try {
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > SEC_CACHE_TTL_MS) return null; // expired — treat as miss
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}
function setCachedFilingHtml(accessionNumber, html) {
  const p = secCachePath(accessionNumber);
  if (!p) return;
  try { fs.writeFileSync(p, html); } catch {}
}
function evictSecCache() {
  let files;
  try { files = fs.readdirSync(SEC_CACHE_DIR); } catch { return; }
  const now = Date.now();
  let totalBytes = 0, evicted = 0;
  const entries = [];
  for (const f of files) {
    const p = path.join(SEC_CACHE_DIR, f);
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    if (now - stat.mtimeMs > SEC_CACHE_TTL_MS) {
      try { fs.unlinkSync(p); evicted++; } catch {}
      continue;
    }
    entries.push({ p, size: stat.size, mtime: stat.mtimeMs });
    totalBytes += stat.size;
  }
  if (totalBytes > SEC_CACHE_MAX_BYTES) {
    entries.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const e of entries) {
      if (totalBytes <= SEC_CACHE_MAX_BYTES) break;
      try { fs.unlinkSync(e.p); totalBytes -= e.size; evicted++; } catch {}
    }
  }
  console.log(`[sec-cache] size=${(totalBytes / 1024 / 1024).toFixed(1)}MB files=${entries.length} evicted=${evicted}`);
}

async function fetchFilingText(url, accessionNumber) {
  try {
    const cached = getCachedFilingHtml(accessionNumber);
    let html;
    if (cached != null) {
      html = cached;
    } else {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'TG-Capital-Local/1.0 contact@osflex.me' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) return null;
      html = await r.text();
      setCachedFilingHtml(accessionNumber, html);
    }
    // Inline XBRL filings embed a single large <ix:header>...</ix:header> block of
    // pure taxonomy/context/unit metadata (100k+ chars, not human-readable prose) at
    // or near the top of the document. A generic tag-strip removes the tags but keeps
    // that block's text content, which then dominates any naive truncation — confirmed
    // against a real RKLB 10-Q where "Item 1A" never appeared before char 41,000. Must
    // drop the whole block, tag and contents, before generic stripping.
    html = html.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ');
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      // SEC filings lean on numeric/named HTML entities for curly quotes and dashes
      // (e.g. "Management&#8217;s Discussion" — a literal 7-char gap that broke
      // "management's" section-heading regexes until decoded here).
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&rsquo;|&lsquo;/gi, "'")
      .replace(/&rdquo;|&ldquo;/gi, '"')
      .replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    return text;
  } catch { return null; }
}

// Locates the real body of a named section (not a table-of-contents link to it) by
// taking, among all regex matches of a start pattern, the one with the largest gap to
// the nearest following end-pattern match — TOC entries sit only a few dozen chars from
// the next TOC line, while a real section runs for thousands of chars before the next
// item heading.
// maxLen here is a sanity cap only (guards against a pathological regex match), not a
// "keep it small for the LLM" budget — that truncation, if any, belongs at the point
// where a caller builds an LLM prompt, not here. Deterministic word-counters (lmSentiment,
// dilutionLexicon) have no context-window constraint and should see the FULL section —
// confirmed this mattered in practice: RKLB's real Item 1A runs 116,309 chars, and a
// 20,000-char cap here silently cut off real dilution-risk language before it ever
// reached either the lexicon scorers or the model.
function extractSection(text, startPatterns, endPatterns, maxLen = 300000) {
  const starts = [];
  for (const re of startPatterns) {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = r.exec(text))) starts.push(m.index);
  }
  if (!starts.length) return null;
  const ends = [];
  for (const re of endPatterns) {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = r.exec(text))) ends.push(m.index);
  }
  let best = null;
  for (const s of starts) {
    const nextEnd = ends.filter(e => e > s).sort((a, b) => a - b)[0];
    const span = (nextEnd != null ? nextEnd : text.length) - s;
    if (span > 1500 && (!best || span > best.span)) best = { start: s, end: nextEnd != null ? nextEnd : text.length, span };
  }
  if (!best) return null;
  return text.slice(best.start, Math.min(best.end, best.start + maxLen)).trim();
}

// Pulls "Item 1A Risk Factors" and "Item 7"(10-K)/"Item 2"(10-Q) MD&A out of a filing's
// cleaned full text. 10-Ks and 10-Qs use different item numbers for MD&A, and 10-Qs
// often skip Risk Factors entirely (only required on "material changes" — a legitimate
// null result, not an extraction failure).
// 20-F filings (foreign private issuers, e.g. Nu Holdings) interleave an extreme density
// of internal cross-references ("see 'Item 5...'", "as described in 'Item 6...'")
// throughout their own body prose — verified against a real NU 20-F, where the plain
// largest-gap heuristic in extractSection() repeatedly picked citation text instead of
// the real section body. Real headings in these filings are never wrapped in quotes;
// citations always are ("...Item 5. Operating and Financial Review and Prospects\"...")
// — except the "Key Information—D. Risk Factors" citation form, which quotes AFTER
// rather than before, so that's checked separately. This filters matches on both
// signals before applying the same largest-gap heuristic as extractSection().
function extractSectionFiltered(text, startPatterns, endPatterns, maxLen = 150000) {
  const QUOTE_BEFORE = /[“‘"']\s*$/;
  const KEY_INFO_BEFORE = /key\s*information\s*[—–-]\s*$/i;
  function realMatches(patterns) {
    const out = [];
    for (const re of patterns) {
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = r.exec(text))) {
        const before5 = text.slice(Math.max(0, m.index - 5), m.index);
        const before30 = text.slice(Math.max(0, m.index - 30), m.index);
        if (QUOTE_BEFORE.test(before5) || KEY_INFO_BEFORE.test(before30)) continue;
        out.push(m.index);
      }
    }
    return out;
  }
  const starts = realMatches(startPatterns);
  if (!starts.length) return null;
  const ends = realMatches(endPatterns);
  let best = null;
  for (const s of starts) {
    const nextEnd = ends.filter(e => e > s).sort((a, b) => a - b)[0];
    const span = (nextEnd != null ? nextEnd : text.length) - s;
    if (span > 1500 && (!best || span > best.span)) best = { start: s, end: nextEnd != null ? nextEnd : text.length, span };
  }
  if (!best) return null;
  return text.slice(best.start, Math.min(best.end, best.start + maxLen)).trim();
}

function extractRiskAndMDA(text, formType) {
  const isTenK = /^10-K/i.test(formType || '');
  const isTwentyF = /^20-F/i.test(formType || '');
  const isSixK = /^6-K/i.test(formType || '');

  if (isSixK) {
    // A 6-K has no fixed Item structure at all — it's whatever material update the
    // foreign private issuer chose to file (earnings release, agreement, etc). Guessing
    // a Risk/MD&A split here would be dishonest; report both as not found, same as a
    // 10-Q with no material Risk Factors changes.
    return { risk: null, mda: null };
  }

  if (isTwentyF) {
    // Item numbers ARE standardized for 20-F (3.D Risk Factors, 5 Operating and
    // Financial Review and Prospects) but, unlike 10-K, the heading PROSE around them is
    // not standardized the same way — different filers word subsection headings
    // differently, so this matches on the Item numbers/structure, filtered through
    // extractSectionFiltered rather than the plain extractSection used for 10-K/10-Q.
    return {
      risk: extractSectionFiltered(text, [/\b[A-Z]\.\s*Risk\s*Factors\b/g], [/ITEM\s*5\.?\s*OPERATING\s*AND\s*FINANCIAL\s*REVIEW/gi]),
      mda: extractSectionFiltered(text, [/ITEM\s*5\.?\s*OPERATING\s*AND\s*FINANCIAL\s*REVIEW/gi], [/ITEM\s*6\.?\s*DIRECTORS/gi]),
    };
  }

  const riskStart = [/item\s*1a\.?\s*risk\s*factors/gi];
  const mdaStart = isTenK
    ? [/item\s*7\.?\s*management.?s\s*discussion\s*and\s*analysis/gi]
    : [/item\s*2\.?\s*management.?s\s*discussion\s*and\s*analysis/gi];
  const riskEnd = isTenK
    ? [/item\s*1b\.?\s*unresolved\s*staff\s*comments/gi, /item\s*2\.?\s*properties/gi]
    : [/item\s*2\.?\s*unregistered\s*sales/gi, /item\s*3\.?\s*defaults\s*upon\s*senior\s*securities/gi, /item\s*6\.?\s*exhibits/gi];
  const mdaEnd = isTenK
    ? [/item\s*7a\.?\s*quantitative\s*and\s*qualitative/gi, /item\s*8\.?\s*financial\s*statements/gi]
    : [/item\s*3\.?\s*quantitative\s*and\s*qualitative/gi, /item\s*4\.?\s*controls\s*and\s*procedures/gi];
  return {
    risk: extractSection(text, riskStart, riskEnd),
    mda: extractSection(text, mdaStart, mdaEnd),
  };
}

// 8-K item-number + body extraction. Unlike 10-K/20-F, 8-Ks are short (verified against
// real filings: 3.7KB-16KB cleaned text) and don't need aggressive section-truncation —
// the whole body between the first real item heading and SIGNATURES fits comfortably in
// any model's context. Real item headings ("Item 8.01 Other Events.") are followed by
// substantial prose; cross-reference citations ("Item 2.02 of this Current Report...")
// aren't — same "largest gap wins" signal used elsewhere, just simpler since 8-Ks are
// short enough that the full largest-gap heuristic over the whole item list is reliable
// without 20-F's citation-density problem.
const EIGHT_K_ITEM_RE = /Item\s+(\d{1,2}\.\d{2})/gi;
function extract8KItemNumbers(text) {
  const positions = {}; // itemNumber -> [indices]
  let m;
  const re = new RegExp(EIGHT_K_ITEM_RE.source, 'gi');
  while ((m = re.exec(text))) {
    const item = m[1];
    (positions[item] = positions[item] || []).push(m.index);
  }
  // For items appearing more than once (heading + later cross-reference), the real
  // heading is whichever occurrence has the most content before the next occurrence of
  // ANY item number — same principle as extractSection's TOC-vs-body disambiguation.
  const allPositions = Object.values(positions).flat().sort((a, b) => a - b);
  const realHeadingPos = {};
  for (const [item, idxs] of Object.entries(positions)) {
    let best = null;
    for (const idx of idxs) {
      const nextOther = allPositions.find(p => p > idx);
      const span = (nextOther != null ? nextOther : text.length) - idx;
      if (!best || span > best.span) best = { idx, span };
    }
    realHeadingPos[item] = best.idx;
  }
  return Object.entries(realHeadingPos)
    .sort((a, b) => a[1] - b[1])
    .map(([item]) => item);
}

function extract8KBody(text, maxLen = 30000) {
  const re = new RegExp(EIGHT_K_ITEM_RE.source, 'gi');
  const positions = [];
  let m;
  while ((m = re.exec(text))) positions.push(m.index);
  if (!positions.length) return null;
  const start = Math.min(...positions);
  const sigMatch = /SIGNATURES?\b/i.exec(text.slice(start));
  const end = sigMatch ? start + sigMatch.index : text.length;
  return text.slice(start, Math.min(end, start + maxLen)).trim();
}

// Shared by analyze8KWithLlama (watchlist, CONTRADICTION_MODEL) and
// triageEightKWithLlama (ticker-universe firehose, EIGHT_K_TRIAGE_MODEL) —
// same task, same JSON shape, only the model differs.
function build8KAnalysisPrompt(ticker, itemNumbers, bodyText) {
  return `You are analyzing a Form 8-K (Current Report) filed by ${ticker}. Item(s) disclosed: ${itemNumbers.join(', ') || 'unknown'}.

=== 8-K BODY TEXT ===
${bodyText}

Respond with ONLY a JSON object matching this exact shape, no other text:
{
  "summary": "2-3 sentences, plain language, describing what this filing actually discloses",
  "sentiment": "positive" | "neutral" | "negative",
  "material_event": true or false — true only if this disclosure is likely to move the stock price (earnings, M&A, executive changes, major contracts, guidance changes, restatements, delisting/going-concern risk; false for routine/administrative items),
  "key_items": [${itemNumbers.map(i => `"${i}"`).join(', ')}],
  "catalyst": "one sentence naming a concrete potential catalyst this filing points to (upcoming earnings, pending deal closing, guidance date, contract milestone, litigation ruling, etc.) — or null if the text names no forward-looking trigger",
  "bearish_signal": true or false — true only if the text itself discloses something concretely negative (missed guidance, revenue/margin decline, exec departure under a cloud, covenant/going-concern language, litigation risk, customer loss, delisting risk, dilutive financing). false for neutral/positive/routine filings — do not infer bearishness from silence,
  "confidence": a number from 0 to 1
}
Base everything only on the text above — do not invent facts not present in it. If there is no real catalyst or bearish signal, say so plainly (null / false) rather than manufacturing one.`;
}

// 8-K material-event analysis. Reuses CONTRADICTION_MODEL (same "financial document ->
// structured JSON" task as the Truth Check Contradiction Engine, no reason for a second
// model config) and the same think:false + content/thinking fallback fix confirmed
// necessary for this model's JSON-mode output.
async function analyze8KWithLlama(ticker, itemNumbers, bodyText) {
  const prompt = build8KAnalysisPrompt(ticker, itemNumbers, bodyText);

  const { parsed } = await ollamaChatWithFallback(CONTRADICTION_MODEL, CONTRADICTION_MODEL_FALLBACK, {
    messages: [{ role: 'user', content: prompt }],
    format: 'json',
    stream: false,
    think: false,
    options: { temperature: 0.2, num_predict: 1024 },
  }, 120000, (data) => {
    const raw = data.message?.content || data.message?.thinking || '';
    return { parsed: JSON.parse(raw || '{}'), raw }; // throws on malformed JSON — triggers the fallback retry
  });
  return parsed;
}

// Same analysis, cheap model — for the ticker-universe firehose, where volume
// (thousands of filings/day market-wide) makes CONTRADICTION_MODEL too slow/
// expensive to run on every one. Never called for watchlist tickers.
async function triageEightKWithLlama(ticker, itemNumbers, bodyText) {
  const prompt = build8KAnalysisPrompt(ticker, itemNumbers, bodyText);
  const { parsed } = await ollamaChatWithFallback(EIGHT_K_TRIAGE_MODEL, CONTRADICTION_MODEL_FALLBACK, {
    messages: [{ role: 'user', content: prompt }],
    format: 'json',
    stream: false,
    think: false,
    options: { temperature: 0.2, num_predict: 1024 },
  }, 120000, (data) => {
    const raw = data.message?.content || data.message?.thinking || '';
    return { parsed: JSON.parse(raw || '{}'), raw };
  });
  return parsed;
}

// ── 8-K discovery loop ─────────────────────────────────────────────────────────
// EDGAR-aligned schedule, not a blind fixed interval. Dense (5-min) coverage in
// the two windows where 8-Ks actually cluster — premarket and the post-close
// filing rush (EDGAR treats anything submitted after 5:30pm ET as filed the next
// business day) — plus hourly coverage through the regular session so a mid-day
// filing is never missed for a full 10 hours like it was on 2026-08-17, and one
// late sweep before EDGAR's 10pm ET cutoff. Not literal 30-60s polling: a full
// loop over the watchlist already takes ~25-30s, so anything near that interval
// would leave the loop running near-continuously for hours, multiplying EDGAR
// traffic and alert-flood risk (see the 73-email incident guarded against
// elsewhere in this file) for little latency gain over 5 minutes.
function etSlotsEvery(startHHMM, endHHMM, stepMinutes) {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const out = [];
  for (let t = sh * 60 + sm; t <= eh * 60 + em; t += stepMinutes) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}
const DISCOVERY_ET_SLOTS = [
  ...etSlotsEvery('06:00', '09:30', 5),   // premarket cluster
  ...etSlotsEvery('10:30', '15:30', 60),  // regular session, hourly
  ...etSlotsEvery('16:00', '18:00', 5),   // post-close filing rush
  '21:45',                                // late-filer sweep before EDGAR's 10pm ET cutoff
];
let lastDiscoverySlotFired = null; // "YYYY-MM-DD THH:MM" — dedups within a slot
function currentEtHHMM() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}`;
}
function currentEtDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); // YYYY-MM-DD
}
const LLAMA_MAX_RETRIES = 5;
const LLAMA_RETRY_BACKOFF_SECONDS = 30 * 60; // 30 min between retries
// How far back a filing can be and still enter the AUTOMATIC analysis/alert
// pipeline (the discovery loop's default no-args call). Exists specifically so
// that fetching a ticker's full filing history (watchlist add, manual refresh,
// ad-hoc lookup — anything that pulls 450 days back) can never queue a flood of
// alerts for old filings — 7 days per explicit user requirement ("no older data
// than 7 days"), comfortably covers the EDGAR-aligned discovery schedule (see
// runDiscoveryLoop) plus any missed runs. The osterm.html/Proactive Scout manual
// ticker-analysis path explicitly overrides this with a wider window for its own
// detail-view purposes, but never lets those filings reach an alert regardless
// of age — see analyzeAndStorePending8Ks's `suppressAlerts` option.
const EIGHT_K_ANALYSIS_MAX_AGE_DAYS = 7;

// Analyzes every 8-K on file that hasn't been analyzed yet (or is due for retry) —
// "queue for retry, don't block the loop" per spec: a failure just increments
// llama_retry_count and sets llama_next_retry_at, this function moves on to the next one.
// Scoped to watchlist tickers and recent filings only (see EIGHT_K_ANALYSIS_MAX_AGE_DAYS) —
// this is the single choke point that keeps a bulk historical fetch from ever reaching
// sendConsolidatedMaterialAlert, so there's nothing further downstream that needs its own guard.
// Optional { ticker, maxAgeDays } scopes this to one ticker with a wider window —
// used by the osterm.html on-demand ticker-onboarding flow (POST /api/scout/
// 8k-analysis/run), which explicitly must NOT touch the rest of the watchlist (see
// the 73-email incident earlier this session). Safe to widen maxAgeDays there
// because that path never calls sendConsolidatedMaterialAlert — the freshness guard's
// whole purpose was preventing a stale-filing *alert* flood, not limiting analysis
// itself. Called with no args (the discovery loop's normal case), behavior is
// unchanged: every watchlist ticker, the default freshness window.
//
// suppressAlerts: true stamps alert_sent_at on every filing analyzed in this call,
// immediately — not just "leave it for the alert functions to skip," but making it
// structurally impossible for a LATER automatic discovery run to pick up and email
// about something a manual action surfaced. Per explicit user requirement: manually
// analyzing a ticker via osterm.html or the Proactive Scout dashboard must never
// itself lead to an email, ever, regardless of how material the filing is.
// scope: 'watchlist' (default, unchanged behavior) analyzes only
// scout_watchlist tickers with analyze8KWithLlama/CONTRADICTION_MODEL.
// scope: 'universe' analyzes scout_ticker_universe tickers that are NOT also
// on the watchlist (that overlap always goes through the watchlist path) with
// the cheap triageEightKWithLlama/EIGHT_K_TRIAGE_MODEL instead — the volume
// difference (thousands vs. dozens of filings/day) is exactly why this needs
// its own cheaper model rather than reusing analyze8KWithLlama.
async function analyzeAndStorePending8Ks({ ticker = null, maxAgeDays = EIGHT_K_ANALYSIS_MAX_AGE_DAYS, suppressAlerts = false, scope = 'watchlist' } = {}) {
  const scopeClause = scope === 'universe'
    ? `AND ticker IN (SELECT ticker FROM scout_ticker_universe) AND ticker NOT IN (SELECT ticker FROM scout_watchlist)`
    : `AND ticker IN (SELECT ticker FROM scout_watchlist)`;
  const analyzeFn = scope === 'universe' ? triageEightKWithLlama : analyze8KWithLlama;
  const pending = db.prepare(`
    SELECT * FROM scout_sec_filings
    WHERE form_type = '8-K'
      AND llama_analyzed_at IS NULL
      AND llama_retry_count < ?
      AND (llama_next_retry_at IS NULL OR llama_next_retry_at <= datetime('now'))
      ${scopeClause}
      AND filed_at >= datetime('now', ?)
      ${ticker ? 'AND ticker = ?' : ''}
  `).all(...(ticker
    ? [LLAMA_MAX_RETRIES, `-${maxAgeDays} days`, ticker]
    : [LLAMA_MAX_RETRIES, `-${maxAgeDays} days`]));

  let analyzed = 0, failed = 0;
  for (const f of pending) {
    try {
      const fullText = await fetchFilingText(f.filing_url, f.accession_number);
      if (!fullText) throw new Error('could not fetch filing text');
      const itemNumbers = extract8KItemNumbers(fullText);
      const body = extract8KBody(fullText);
      if (!body) throw new Error('could not locate an Item body in this 8-K');
      const cik = (String(f.filing_url || '').match(/\/data\/(\d+)\//) || [])[1] || null;

      const { parsed, raw } = await analyzeFn(f.ticker, itemNumbers, body);
      db.prepare(`
        UPDATE scout_sec_filings SET
          cik = COALESCE(cik, ?), llama_summary = ?, llama_sentiment = ?,
          llama_material_event = ?, llama_key_items = ?, llama_confidence = ?,
          llama_raw_response = ?, llama_analyzed_at = datetime('now'),
          llama_catalyst = ?, llama_bearish_signal = ?
          ${suppressAlerts ? ', alert_sent_at = datetime(\'now\')' : ''}
        WHERE id = ?
      `).run(
        cik, parsed.summary || '', parsed.sentiment || 'neutral',
        parsed.material_event ? 1 : 0, JSON.stringify(parsed.key_items || itemNumbers),
        Number.isFinite(parsed.confidence) ? parsed.confidence : null, raw,
        parsed.catalyst || null, parsed.bearish_signal ? 1 : 0, f.id,
      );
      scoutLogLine({ event: '8k_analysis', ticker: f.ticker, accession: f.accession_number, material: !!parsed.material_event, bearish: !!parsed.bearish_signal });
      analyzed++;
    } catch (e) {
      db.prepare(`
        UPDATE scout_sec_filings SET
          llama_retry_count = llama_retry_count + 1,
          llama_next_retry_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(LLAMA_RETRY_BACKOFF_SECONDS, f.id);
      scoutLogLine({ event: '8k_analysis_failed', ticker: f.ticker, accession: f.accession_number, error: e.message });
      failed++;
    }
  }
  return { checked: pending.length, analyzed, failed };
}

// Guards against the automatic scheduled run and a manual trigger (or two manual
// triggers) overlapping — confirmed happening in practice: an early manual test run
// landed on top of the 60s-after-boot automatic run, and 148 filings got analyzed twice
// each (wasted duplicate Llama calls; no data corruption since UPDATE ... WHERE id = ?
// is idempotent, but real wasted work worth preventing).
let discoveryLoopRunning = false;
// ── Alert dispatch: immediate email per material 8-K, daily digest for the rest ──
function getAlertSettings() { return db.prepare(`SELECT * FROM scout_alert_settings WHERE id = 1`).get(); }
function gmailReady() { return !!(loadGmailTokens()?.refresh_token && GMAIL_SEND_TO); }

// One email covering every currently-unsent qualifying material 8-K, grouped
// by ticker — per explicit user requirement, replacing the old one-email-per-
// filing behavior (dispatchMaterialAlerts, removed) which was flooding the
// inbox with a separate email per ticker. Also reachable on demand via
// POST /api/scout/alerts/send-consolidated for clearing a backlog.
async function sendConsolidatedMaterialAlert() {
  const settings = getAlertSettings();
  if (settings?.alerts_paused) return { sent: false, skipped: 'paused' };
  if (!gmailReady()) return { sent: false, skipped: 'gmail_not_configured' };

  // Same filter as recent-filings' dashboard query — positive sentiment only
  // (neutral/negative material events aren't dropped, they just don't get
  // alert_sent_at stamped here, so they flow into the daily digest instead).
  // Watchlist tickers always qualify; universe tickers additionally need
  // Technology sector AND the same liquidity floor as everywhere else in the
  // firehose — all three required together per explicit user requirement.
  const pending = db.prepare(`
    SELECT * FROM scout_sec_filings
    WHERE form_type = '8-K' AND llama_material_event = 1
      AND llama_analyzed_at IS NOT NULL AND alert_sent_at IS NULL
      AND llama_sentiment = 'positive'
      AND (
        ticker IN (SELECT ticker FROM scout_watchlist)
        OR (
          ticker IN (SELECT symbol FROM sector_cache WHERE sector = 'Technology')
          AND ticker IN (SELECT ticker FROM scout_ticker_universe WHERE avg_volume IS NULL OR avg_volume >= ?)
        )
      )
    ORDER BY ticker, filed_at DESC
  `).all(UNIVERSE_MIN_AVG_VOLUME);
  if (!pending.length) return { sent: false, skipped: 'nothing_pending' };

  const byTicker = {};
  for (const f of pending) (byTicker[f.ticker] = byTicker[f.ticker] || []).push(f);
  const tickers = Object.keys(byTicker).sort();
  const bearishTickers = tickers.filter(t => byTicker[t].some(f => f.llama_bearish_signal));

  const bearishBanner = bearishTickers.length
    ? `⚠ BEARISH WATCHLIST: ${bearishTickers.join(', ')}\n${'='.repeat(40)}\n\n`
    : '';

  const body = bearishBanner + tickers.map(ticker => {
    const filings = byTicker[ticker];
    const filingBlocks = filings.map(f => {
      const keyItems = (JSON.parse(f.llama_key_items || '[]') || []).join(', ');
      return [
        `  ${(f.filed_at || '').slice(0, 10)} — Item(s) ${keyItems || '—'}${f.llama_bearish_signal ? '  [⚠ BEARISH]' : ''}`,
        `  ${f.llama_summary || '(no summary)'}`,
        `  Sentiment: ${f.llama_sentiment || '—'}  |  Confidence: ${f.llama_confidence != null ? Math.round(f.llama_confidence * 100) + '%' : '—'}`,
        f.llama_catalyst ? `  Potential catalyst: ${f.llama_catalyst}` : null,
        `  ${f.filing_url}`,
      ].filter(x => x !== null).join('\n');
    }).join('\n\n');
    return `${ticker} (${filings.length} filing${filings.length > 1 ? 's' : ''})\n${'-'.repeat(40)}\n${filingBlocks}`;
  }).join('\n\n\n');

  const subject = `${bearishTickers.length ? '[SEC Alert ⚠ BEARISH] ' : '[SEC Alert] '}${pending.length} material filing(s) across ${tickers.length} ticker(s)`;
  try {
    await sendGmailAlert(subject, body);
    const markSent = db.prepare(`UPDATE scout_sec_filings SET alert_sent_at = datetime('now') WHERE id = ?`);
    for (const f of pending) markSent.run(f.id);
    scoutLogLine({ event: 'consolidated_alert_sent', count: pending.length, tickers: tickers.length });
    return { sent: true, count: pending.length, tickers: tickers.length };
  } catch (e) {
    scoutLogLine({ event: 'consolidated_alert_failed', error: e.message });
    return { sent: false, error: e.message };
  }
}

// Called from the discovery loop (2-3x/day, not every minute) — this is a "has the
// configured local time passed yet today, and have we not already sent" check, not a
// precise-to-the-minute trigger.
async function maybeSendDailyDigest() {
  const settings = getAlertSettings();
  if (settings?.alerts_paused) return { sent: false, skipped: 'paused' };
  if (!gmailReady()) return { sent: false, skipped: 'gmail_not_configured' };

  const todayStr = new Date().toISOString().slice(0, 10);
  if (settings?.last_digest_sent_date === todayStr) return { sent: false, skipped: 'already_sent_today' };

  const [hh, mm] = (settings?.digest_time || '08:00').split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return { sent: false, skipped: 'not_yet_time' };

  // Everything not already alert_sent_at-stamped — watchlist non-material
  // filings (as before) PLUS any universe filing that didn't clear
  // sendConsolidatedMaterialAlert's full bar (material + positive sentiment +
  // Technology sector + liquidity) — a universe filing that fails any one of
  // those never gets alert_sent_at stamped, so it lands here instead. This is
  // the "essential notifications only" compromise for the firehose per
  // explicit user requirement: universe material events still surface (tagged
  // [MATERIAL] below, sorted first), just in the daily digest instead of an
  // immediate email.
  const digestItems = db.prepare(`
    SELECT * FROM scout_sec_filings
    WHERE form_type = '8-K'
      AND llama_analyzed_at >= datetime('now', '-1 day')
      AND alert_sent_at IS NULL
    ORDER BY llama_material_event DESC, filed_at DESC
  `).all();

  if (!digestItems.length) {
    db.prepare(`UPDATE scout_alert_settings SET last_digest_sent_date = ? WHERE id = 1`).run(todayStr);
    return { sent: false, skipped: 'nothing_to_digest' };
  }

  const bearishTickers = [...new Set(digestItems.filter(f => f.llama_bearish_signal).map(f => f.ticker))];
  const bearishBanner = bearishTickers.length
    ? `⚠ BEARISH WATCHLIST: ${bearishTickers.join(', ')}\n${'='.repeat(40)}\n\n`
    : '';

  // Sentiment shown per-filing is the same real llama_sentiment field already
  // computed for every 8-K (material or not) — not a new LLM call, not a new
  // score. "Worth a closer look" is the honest version of a recommendation for
  // an otherwise-non-material digest: flagged only when sentiment leans off
  // neutral, since that's the one real signal available here that a routine
  // filing might deserve more attention than the digest format implies.
  const body = bearishBanner + digestItems.map(f => {
    const keyItems = (JSON.parse(f.llama_key_items || '[]') || []).join(', ');
    const notable = f.llama_sentiment && f.llama_sentiment !== 'neutral';
    return [
      `${f.ticker} — ${keyItems} — ${(f.filed_at || '').slice(0, 10)}${f.llama_material_event ? '  [MATERIAL]' : ''}${f.llama_bearish_signal ? '  [⚠ BEARISH]' : ''}${notable && !f.llama_bearish_signal ? '  [👀 worth a closer look]' : ''}`,
      `  ${f.llama_summary || ''}`,
      f.llama_sentiment ? `  Sentiment: ${f.llama_sentiment}` : null,
      f.llama_catalyst ? `  Potential catalyst: ${f.llama_catalyst}` : null,
      `  ${f.filing_url}`,
    ].filter(x => x !== null).join('\n');
  }).join('\n\n');

  try {
    await sendGmailAlert(`${bearishTickers.length ? '[SEC Digest ⚠ BEARISH] ' : '[SEC Digest] '}${digestItems.length} filing(s)`, body);
    db.prepare(`UPDATE scout_alert_settings SET last_digest_sent_date = ? WHERE id = 1`).run(todayStr);
    return { sent: true, count: digestItems.length };
  } catch (e) {
    scoutLogLine({ event: 'digest_failed', error: e.message });
    return { sent: false, error: e.message };
  }
}

async function runDiscoveryLoop() {
  if (discoveryLoopRunning) {
    scoutLogLine({ event: 'discovery_loop_skipped', reason: 'already_running' });
    return { skipped: true, reason: 'already_running' };
  }
  discoveryLoopRunning = true;
  scoutLogLine({ event: 'discovery_loop_start' });
  try {
    const tickers = db.prepare(`SELECT ticker FROM scout_watchlist ORDER BY ticker`).all().map(r => r.ticker);
    for (const t of tickers) {
      await fetchAndStoreSecFilingsForNewTicker(t);
      await new Promise(r => setTimeout(r, 300)); // courtesy delay between EDGAR calls
    }
    const analysisResult = await analyzeAndStorePending8Ks();

    // Ticker-universe firehose — every US, major-exchange-listed (no OTC)
    // company, not just the watchlist. Bulk daily-index fetch (not a per-
    // ticker loop, see ingestUniverseFilingsFromDailyIndex), triaged with the
    // cheap EIGHT_K_TRIAGE_MODEL. Sync is staleness-guarded internally so this
    // is a cheap no-op call on every loop except roughly once a week.
    await syncTickerUniverse().catch(e => scoutLogLine({ event: 'ticker_universe_sync_failed', error: e.message }));
    // Runs to completion every tick (not bounded like sector, below) — Schwab's
    // batched /quotes endpoint makes a full pass affordable in ~40 calls, so
    // ingest below always sees current volume rather than needing days to warm up.
    const universeVolumeResult = await refreshUniverseVolume()
      .catch(e => { scoutLogLine({ event: 'universe_volume_sync_failed', error: e.message }); return { error: e.message }; });
    // Bounded batch per tick (~55s at Finnhub's throttle) — a full pass over
    // ~7,700 symbols takes days of ticks to complete, not one call; sector_cache's
    // own fetched_at/stale bookkeeping is what makes that resumable, see
    // refreshUniverseSectorCache's comment in sectors.js. Restored per explicit
    // user requirement — Technology sector is required again alongside
    // sentiment/volume in sendConsolidatedMaterialAlert and recent-filings.
    const universeSectorResult = await sectors.refreshUniverseSectorCache(db, FINNHUB_API_KEY, { limit: 50 })
      .catch(e => { scoutLogLine({ event: 'universe_sector_sync_failed', error: e.message }); return { error: e.message }; });
    const universeIngestResult = await ingestUniverseFilingsFromDailyIndex().catch(e => {
      scoutLogLine({ event: 'universe_firehose_ingest_failed', error: e.message });
      return { fetched: 0, inserted: 0, error: e.message };
    });
    const universeAnalysisResult = await analyzeAndStorePending8Ks({ scope: 'universe' });

    const alertResult = await sendConsolidatedMaterialAlert();
    const digestResult = await maybeSendDailyDigest();
    evictSecCache(); // per spec: run the eviction check after every discovery loop iteration
    scoutLogLine({ event: 'discovery_loop_end', tickers: tickers.length, ...analysisResult, universe: { volumeSync: universeVolumeResult, sectorSync: universeSectorResult, ingest: universeIngestResult, ...universeAnalysisResult }, alerts: alertResult, digest: digestResult });
    return { tickers: tickers.length, ...analysisResult, universe: { volumeSync: universeVolumeResult, sectorSync: universeSectorResult, ingest: universeIngestResult, ...universeAnalysisResult }, alerts: alertResult, digest: digestResult };
  } catch (e) {
    scoutLogLine({ event: 'discovery_loop_error', error: e.message });
    throw e;
  } finally {
    discoveryLoopRunning = false;
  }
}

// Runs once ~60s after boot (so a freshly-started container doesn't sit idle
// until the next scheduled window if something was missed while it was down),
// then checks every 60s afterward for whether "now" (America/New_York, DST-
// correct via Intl) matches one of DISCOVERY_ET_SLOTS. Checking every 60s (not
// 5 min) is deliberate: a setInterval anchored to an arbitrary boot-time second
// offset would, at 5-min granularity, only ever land on minutes sharing that
// offset's residue mod 5 — it could permanently miss every :00/:15/:30/:45 slot
// depending on what second the container happened to start. Stepping by exactly
// 1 minute is the only interval that's guaranteed to pass through every minute
// value regardless of phase. The check itself is a cheap string comparison, not
// a network call — this isn't the continuous-polling pattern the app moved away
// from; only an actual slot match ever triggers real work.
setTimeout(() => runDiscoveryLoop().catch(() => {}), 60000);
setInterval(() => {
  const hhmm = currentEtHHMM();
  if (!DISCOVERY_ET_SLOTS.includes(hhmm)) return;
  const slotKey = `${currentEtDateStr()}T${hhmm}`;
  if (lastDiscoverySlotFired === slotKey) return;
  lastDiscoverySlotFired = slotKey;
  scoutLogLine({ event: 'discovery_slot_fired', slot: slotKey });
  runDiscoveryLoop().catch(() => {});
}, 60 * 1000);

// Single-ticker 8-K analysis — the osterm.html "search a new ticker" onboarding
// flow's analysis step. Deliberately NOT the discovery loop: scoped to exactly one
// ticker (see analyzeAndStorePending8Ks's own comment), wider 180-day window since
// this path never dispatches alerts, so the freshness guard's original rationale
// (preventing a stale-filing *email* flood) doesn't apply here.
app.post('/api/scout/8k-analysis/run', async (req, res) => {
  try {
    const ticker = String(req.body?.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    const result = await analyzeAndStorePending8Ks({ ticker, maxAgeDays: 180, suppressAlerts: true });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Real state, computed fresh on every call — not a stored "job status" row, so
// there's nothing to go stale or get out of sync with what's actually in the DB.
// Used by osterm.html to poll onboarding progress and to detect a ticker that's
// watchlisted but never finished analysis (the RTX incident: onboarding started,
// the browser tab lost focus mid-sequence, and the old sequential-await client
// code had no way to resume — this function is what makes resuming possible).
const ONBOARD_8K_ANALYSIS_WINDOW_DAYS = 180; // must match the maxAgeDays onboardTickerInBackground actually analyzes
function computeOnboardStatus(ticker) {
  const watchlisted = !!db.prepare(`SELECT 1 FROM scout_watchlist WHERE ticker = ?`).get(ticker);
  const filings = db.prepare(`SELECT COUNT(*) n FROM scout_sec_filings WHERE ticker = ?`).get(ticker).n;
  // Scoped to the same window the analysis step actually targets — a ticker can
  // have real 8-Ks older than that which are intentionally never analyzed (see
  // EIGHT_K_ANALYSIS_MAX_AGE_DAYS's reasoning); counting those against
  // "complete" meant a ticker like GD (7 of 12 8-Ks older than 180 days) could
  // never register as done, so it silently re-triggered onboarding on every
  // single visit — confirmed live, not hypothetical.
  const windowClause = `AND filed_at >= datetime('now', '-${ONBOARD_8K_ANALYSIS_WINDOW_DAYS} days')`;
  const eightKs = db.prepare(`SELECT COUNT(*) n FROM scout_sec_filings WHERE ticker = ? AND form_type = '8-K' ${windowClause}`).get(ticker).n;
  const analyzed8Ks = db.prepare(`SELECT COUNT(*) n FROM scout_sec_filings WHERE ticker = ? AND form_type = '8-K' AND llama_analyzed_at IS NOT NULL ${windowClause}`).get(ticker).n;
  // A filing that's exhausted its retries (llama_retry_count >= LLAMA_MAX_RETRIES)
  // is permanently excluded from analyzeAndStorePending8Ks's WHERE clause — it
  // will never become analyzed. Without counting these as "settled" separately,
  // analyzed8Ks can never reach eightKs and onboarding spins on "Analyzing 8-K
  // filings" forever with no visible failure state (confirmed live: a single
  // filing with a bad filing_url froze META's onboarding indefinitely — see git
  // history on this function for the incident).
  const failed8Ks = db.prepare(`SELECT COUNT(*) n FROM scout_sec_filings WHERE ticker = ? AND form_type = '8-K' AND llama_analyzed_at IS NULL AND llama_retry_count >= ? ${windowClause}`).get(ticker, LLAMA_MAX_RETRIES).n;
  const hasTruthCheck = !!db.prepare(`SELECT 1 FROM scout_contradictions WHERE ticker = ? LIMIT 1`).get(ticker);
  return {
    watchlisted, filings, eightKs, analyzed8Ks, failed8Ks, hasTruthCheck,
    complete: watchlisted && filings > 0 && (analyzed8Ks + failed8Ks) >= eightKs && hasTruthCheck,
  };
}

// The full new-ticker pipeline (watchlist add → SEC fetch → 8-K analysis → Truth
// Check), run entirely server-side and NOT awaited by its caller — this is the
// actual fix for "browser closed / phone lost signal mid-onboarding": once this
// function starts, it keeps running on the Node event loop independent of any
// HTTP connection, so there's nothing for a client disconnect to interrupt.
// Idempotent by construction: watchlist insert is OR IGNORE, 8-K analysis only
// touches unanalyzed filings, so calling this again on a partially-onboarded
// ticker (e.g. the RTX case) just picks up wherever it actually stopped rather
// than redoing finished work — except Truth Check, which always adds a new row,
// so it's explicitly skipped here if one already exists.
async function onboardTickerInBackground(ticker) {
  scoutLogLine({ event: 'onboard_start', ticker });
  try {
    db.prepare(`INSERT OR IGNORE INTO scout_watchlist (ticker) VALUES (?)`).run(ticker);

    const filingsResult = await fetchAndStoreSecFilingsForNewTicker(ticker);
    if (filingsResult.ok === false) {
      scoutLogLine({ event: 'onboard_stopped', ticker, reason: filingsResult.reason });
      return;
    }

    await analyzeAndStorePending8Ks({ ticker, maxAgeDays: 180, suppressAlerts: true });

    const alreadyChecked = !!db.prepare(`SELECT 1 FROM scout_contradictions WHERE ticker = ? LIMIT 1`).get(ticker);
    if (!alreadyChecked) await runContradictionAnalysis(ticker);

    scoutLogLine({ event: 'onboard_complete', ticker });
  } catch (e) {
    scoutLogLine({ event: 'onboard_error', ticker, error: e.message });
  }
}

// Kicks off onboarding and returns immediately — does not wait for the pipeline
// above. If the ticker is already fully onboarded, this is a cheap no-op query,
// not a wasted re-run (Truth Check in particular is expensive; see the guard in
// onboardTickerInBackground).
app.post('/api/scout/onboard-ticker', (req, res) => {
  try {
    const ticker = String(req.body?.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    const status = computeOnboardStatus(ticker);
    if (status.complete) return res.json({ ok: true, ticker, alreadyComplete: true });
    onboardTickerInBackground(ticker); // deliberately not awaited
    res.json({ ok: true, ticker, started: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/scout/onboard-status', (req, res) => {
  try {
    const ticker = String(req.query.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    res.json({ ok: true, ticker, ...computeOnboardStatus(ticker) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Batch "Scan + Sentiment + Truth Check" — single ticker or the whole watchlist,
// same survives-disconnect architecture as onboardTickerInBackground/onboard-status
// above: fire-and-forget background job, real-state (in-memory, not simulated)
// progress via a status endpoint. In-memory rather than DB-backed because this is a
// short-lived job on a single-process app (same reasoning as discoveryLoopRunning) —
// won't survive a server restart mid-run, which is an acceptable tradeoff for a
// manually-triggered run measured in minutes, not hours.
let batchRunState = null; // { tickers, progress: { [ticker]: {scan,sentiment,truthCheck} }, startedAt, done }
const SENTIMENT_FRESH_HOURS = 12; // skip re-crawling sentiment fetched more recently than this
const TRUTH_CHECK_FRESH_HOURS = 6; // skip re-running Truth Check analyzed more recently than this, unless force:true

async function runFullAnalysis(tickers, force) {
  batchRunState = { tickers, progress: {}, startedAt: Date.now(), done: false };
  for (const ticker of tickers) batchRunState.progress[ticker] = { scan: 'pending', sentiment: 'pending', truthCheck: 'pending' };

  for (const ticker of tickers) {
    const p = batchRunState.progress[ticker];
    try {
      p.scan = 'running';
      await scanOneTicker(ticker);
      p.scan = 'done';
    } catch (e) { p.scan = 'error'; scoutLogLine({ event: 'batch_scan_failed', ticker, error: e.message }); }

    try {
      const recentSentiment = db.prepare(`SELECT 1 FROM scout_sentiment WHERE ticker = ? AND fetched_at >= datetime('now', ?) LIMIT 1`)
        .get(ticker, `-${SENTIMENT_FRESH_HOURS} hours`);
      if (recentSentiment && !force) {
        p.sentiment = 'skipped_fresh';
      } else {
        p.sentiment = 'running';
        await crawlSentimentForTicker(ticker);
        p.sentiment = 'done';
      }
    } catch (e) { p.sentiment = 'error'; scoutLogLine({ event: 'batch_sentiment_failed', ticker, error: e.message }); }

    try {
      const recentCheck = db.prepare(`SELECT 1 FROM scout_contradictions WHERE ticker = ? AND analyzed_at >= datetime('now', ?) LIMIT 1`)
        .get(ticker, `-${TRUTH_CHECK_FRESH_HOURS} hours`);
      if (recentCheck && !force) {
        p.truthCheck = 'skipped_fresh';
      } else {
        p.truthCheck = 'running';
        await runContradictionAnalysis(ticker);
        p.truthCheck = 'done';
      }
    } catch (e) { p.truthCheck = 'error'; scoutLogLine({ event: 'batch_truthcheck_failed', ticker, error: e.message }); }
  }
  batchRunState.done = true;
  scoutLogLine({ event: 'batch_analysis_complete', tickers: tickers.length });
}

app.post('/api/scout/analyze', (req, res) => {
  try {
    if (batchRunState && !batchRunState.done) {
      return res.status(409).json({ ok: false, error: 'A batch analysis is already running', progress: batchRunState });
    }
    const reqTicker = req.body?.ticker ? String(req.body.ticker).trim().toUpperCase() : null;
    const tickers = Array.isArray(req.body?.tickers) && req.body.tickers.length
      ? req.body.tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean)
      : reqTicker
      ? [reqTicker]
      : db.prepare(`SELECT ticker FROM scout_watchlist ORDER BY ticker`).all().map(r => r.ticker);
    if (!tickers.length) return res.status(400).json({ ok: false, error: 'No tickers to analyze' });
    runFullAnalysis(tickers, !!req.body?.force); // deliberately not awaited
    res.json({ ok: true, tickers, started: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/scout/analyze-status', (req, res) => {
  res.json({ ok: true, ...(batchRunState || { done: true, tickers: [], progress: {} }) });
});

// Manual trigger — lets you run a full discovery pass on demand instead of waiting for
// the next scheduled interval (e.g. right after adding a ticker with a known 8-K).
app.post('/api/scout/discovery/run', async (req, res) => {
  try {
    const result = await runDiscoveryLoop();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// One email covering every currently-unsent material 8-K, grouped by ticker — for
// clearing a backlog without flooding the inbox with one email per filing.
app.post('/api/scout/alerts/send-consolidated', async (req, res) => {
  try {
    const result = await sendConsolidatedMaterialAlert();
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Pause/resume alerts and set digest time without touching code, per spec.
app.get('/api/scout/alert-settings', (req, res) => {
  res.json({ ok: true, settings: getAlertSettings(), gmail: { configured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GMAIL_SEND_TO), connected: gmailReady() } });
});
app.post('/api/scout/alert-settings', (req, res) => {
  try {
    const { alerts_paused, digest_time } = req.body || {};
    if (alerts_paused !== undefined) {
      db.prepare(`UPDATE scout_alert_settings SET alerts_paused = ? WHERE id = 1`).run(alerts_paused ? 1 : 0);
    }
    if (digest_time !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(digest_time)) return res.status(400).json({ ok: false, error: 'digest_time must be HH:MM' });
      db.prepare(`UPDATE scout_alert_settings SET digest_time = ? WHERE id = 1`).run(digest_time);
    }
    res.json({ ok: true, settings: getAlertSettings() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// osterm.html cross-browser "last viewed ticker" — one shared value (no per-user
// session concept exists on that page), so any browser opening it lands on
// whatever was last viewed anywhere. Deliberately not scoped to watchlist
// membership — viewing a ticker doesn't require it to be tracked.
app.get('/api/scout/last-viewed-ticker', (req, res) => {
  res.json({ ok: true, ticker: getAlertSettings()?.last_viewed_ticker || null });
});
app.post('/api/scout/last-viewed-ticker', (req, res) => {
  try {
    const ticker = String(req.body?.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    db.prepare(`UPDATE scout_alert_settings SET last_viewed_ticker = ? WHERE id = 1`).run(ticker);
    res.json({ ok: true, ticker });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

async function runContradictionAnalysis(ticker, sentimentScore) {
  ticker = String(ticker || '').trim().toUpperCase();
  if (!ticker) throw new Error('ticker is required');
  const score = sentimentScore != null && sentimentScore !== '' ? Number(sentimentScore) : null;
  if (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) {
    throw new Error('sentimentScore must be a number from 0 to 100');
  }

  // Pull filings directly from EDGAR on the spot if none are on file yet —
  // replaces waiting on the scheduled/manual GitHub Actions scraper for the
  // interactive Run All / Truth Check path. The Action can stay as a
  // background freshness sweep; this just means Truth Check never has to
  // tell the user "hasn't been scraped yet" when it can fetch it itself.
  await ensureSecFilingsOnFile(ticker);

  const tenK = db.prepare(`SELECT * FROM scout_sec_filings WHERE ticker = ? AND form_type LIKE '10-K%' ORDER BY filed_at DESC LIMIT 1`).get(ticker);
  const tenQ = db.prepare(`SELECT * FROM scout_sec_filings WHERE ticker = ? AND form_type LIKE '10-Q%' ORDER BY filed_at DESC LIMIT 1`).get(ticker);
  let filings = [tenK, tenQ].filter(Boolean);
  // Foreign private issuers (e.g. Nu Holdings) file Form 20-F/6-K instead of 10-K/10-Q —
  // fall back to those only when no domestic filer forms are on file at all.
  if (!filings.length) {
    const twentyF = db.prepare(`SELECT * FROM scout_sec_filings WHERE ticker = ? AND form_type LIKE '20-F%' ORDER BY filed_at DESC LIMIT 1`).get(ticker);
    const sixK = db.prepare(`SELECT * FROM scout_sec_filings WHERE ticker = ? AND form_type LIKE '6-K%' ORDER BY filed_at DESC LIMIT 1`).get(ticker);
    filings = [twentyF, sixK].filter(Boolean);
  }

  // No manual score means the model needs real crawled sentiment text to derive its own
  // estimate from — auto-crawl here instead of making the user separately hit "Crawl
  // sentiment" first or type a number they'd otherwise have to guess. Fetched up front
  // (before the filings branch) since the no-filings fallback below needs it too.
  let sentimentRow = db.prepare(`SELECT * FROM scout_sentiment WHERE ticker = ? ORDER BY fetched_at DESC LIMIT 1`).get(ticker);
  if (score == null && !sentimentRow) {
    const content = await sentimentWebSearch(ticker);
    if (content) {
      const q = `${ticker} sentiment — restricted to: ${SENTIMENT_SOURCES.join(', ')}`;
      const info = stmtInsertSentiment.run(ticker, q, content);
      sentimentRow = { id: info.lastInsertRowid, ticker, query: q, content, fetched_at: new Date().toISOString() };
    }
  }

  // No 10-K/10-Q on file (e.g. foreign private issuers like Nu Holdings file 20-F/6-K
  // instead — this app doesn't parse those) — fall back to showing general market
  // sentiment alone instead of failing the whole panel outright.
  if (!filings.length) {
    if (score == null && !sentimentRow) {
      return {
        ok: false, reason: 'insufficient_data', have_filings: 0, have_sentiment: false,
        message: `No 10-K/10-Q on file for ${ticker} (it may file Form 20-F/6-K instead as a foreign private issuer, or just hasn't been scraped yet), and no sentiment data available either.`,
      };
    }
    return {
      ok: true, mode: 'sentiment_only', ticker,
      message: `No 10-K or 10-Q on file for ${ticker} — showing general market sentiment only. If ${ticker} is a foreign private issuer, it likely files Form 20-F/6-K instead, which isn't parsed here yet.`,
      sentiment_score: score, sentiment_content: sentimentRow ? sentimentRow.content : null,
      sentiment_fetched_at: sentimentRow ? sentimentRow.fetched_at : null,
    };
  }

  // Filings exist but sentiment genuinely isn't available (no search provider configured,
  // or the crawl came back empty, and no manual score) — proceed with a filing-only
  // analysis (pure Risk Factors vs MD&A internal tension) instead of failing outright.
  const noSentimentContext = score == null && !sentimentRow;

  const sections = [];
  for (const f of filings) {
    const fullText = await fetchFilingText(f.filing_url, f.accession_number);
    const { risk, mda } = fullText ? extractRiskAndMDA(fullText, f.form_type) : { risk: null, mda: null };
    sections.push({ form_type: f.form_type, filed_at: f.filed_at, risk, mda, fetched: !!fullText });
  }

  // Deterministic Loughran-McDonald filing-tone score — pure word-count computation
  // over the ACTUAL extracted Risk Factors/MD&A text already in memory (no extra
  // fetch). Zero LLM involvement; same input always produces the same output. This is
  // a different signal from sentiment_score (retail/market sentiment) — it measures the
  // filing's own tone, not what outside sentiment says about the stock.
  const lmInputSections = [];
  for (const s of sections) {
    const riskLabel = /^20-F/i.test(s.form_type) ? 'Item 3.D Risk Factors' : 'Item 1A Risk Factors';
    if (s.risk) lmInputSections.push({ label: `${s.form_type} ${riskLabel}`, text: s.risk });
    if (s.mda) lmInputSections.push({ label: `${s.form_type} MD&A`, text: s.mda });
  }
  const filingToneLm = lmInputSections.length ? lmSentiment.scoreWeightedSections(lmInputSections) : null;

  // Separate, independently-reported dilution feature set — NOT part of LM tone (see
  // dilutionLexicon.js for why: dilute/dilution/dilutive carry zero LM category
  // classification in any release). Pooled across all available section text.
  const pooledSectionText = lmInputSections.map(s => s.text).join('\n\n');
  const dilutionFeatures = pooledSectionText ? dilutionLexicon.scoreDilution(pooledSectionText) : null;

  // Prompt-budget truncation lives HERE, not in extraction — 18000 chars/section x up to
  // 4 sections (~18k tokens) leaves room in a 32768-ctx model for system prompt + 4096
  // response tokens. The deterministic scorers above already saw the full untruncated text.
  const PROMPT_SECTION_CHAR_CAP = 18000;
  const citationLabel = (s) => `${s.form_type} filed ${(s.filed_at || '').slice(0, 10)}`;
  const secBlock = sections.map(s => {
    const isTwentyF = /^20-F/i.test(s.form_type);
    const isSixK = /^6-K/i.test(s.form_type);
    const riskItem = isTwentyF ? 'Item 3.D' : 'Item 1A';
    const mdaItem = isTwentyF ? 'Item 5' : (/^10-K/i.test(s.form_type) ? 'Item 7' : 'Item 2');
    if (isSixK) {
      // No fixed Item structure — treat as one supplementary blob, not a Risk/MD&A split.
      return `--- ${citationLabel(s)} (Form 6-K — no fixed Item structure; treat as supplementary context) ---\n${(s.risk || s.mda || '(no text extracted)').slice(0, PROMPT_SECTION_CHAR_CAP)}`;
    }
    const riskBody = s.risk ? s.risk.slice(0, PROMPT_SECTION_CHAR_CAP) : (s.fetched ? `(no ${riskItem} Risk Factors section found — for a 10-Q this often legitimately means "no material changes from the last 10-K")` : '(filing text could not be fetched)');
    const mdaBody = s.mda ? s.mda.slice(0, PROMPT_SECTION_CHAR_CAP) : (s.fetched ? `(no ${mdaItem} MD&A section found)` : '(filing text could not be fetched)');
    return `--- ${citationLabel(s)} — ${riskItem} Risk Factors ---\n${riskBody}\n\n--- ${citationLabel(s)} — ${mdaItem} MD&A ---\n${mdaBody}`;
  }).join('\n\n');

  const scoreBlock = score != null
    ? `Current retail sentiment score: ${score}/100 (${score >= 70 ? 'clearly BULLISH' : score <= 30 ? 'bearish' : 'neutral/mixed'}).`
    : noSentimentContext
      ? `No sentiment score or crawled sentiment text is available for ${ticker} — SKIP this step entirely. Base your verdict purely on internal tension between Risk Factors and MD&A within the filing itself, not on any outside sentiment comparison.`
      : `No sentiment score was given directly. Read the crawled market sentiment/news text below (from reputable financial outlets) and estimate a 0-100 retail sentiment score yourself — 70+ = clearly bullish, 30 or under = bearish, in between = neutral/mixed. Report that estimate in the "sentiment_score" field of your JSON response and use it for the rest of this analysis.\n\n=== CRAWLED SENTIMENT TEXT (${ticker}) ===\n${(sentimentRow.content || '').slice(0, 4000)}`;

  const prompt = `You are a forensic financial analyst. Using ONLY the SEC filing text below for ${ticker}, do the following:

1. Identify contradictions or tensions between the "Risk Factors" section and the "MD&A" section — especially where MD&A sounds confident, growth-focused, or reassuring while Risk Factors disclose meaningful downside scenarios, structural vulnerabilities, or uncertainties.
2. Focus particularly on: complex equity structures (convertible debt, preferred shares, warrants, options, share-based compensation, contingent consideration, or anything that can dilute or subordinate common equity); capital structure/liquidity risk (refinancing risk, covenant risk, reliance on short-term funding, capital-markets dependence); off-balance-sheet arrangements (VIEs, securitizations, guarantees, commitments); concentration risk (customers, suppliers, products, geographies, funding sources); regulatory/legal/compliance risk; any asymmetric risk where common shareholders face large downside that is not obvious from a casual bullish narrative.
3. ${scoreBlock}
   Given that context, identify which key risks, caveats, or structural issues from the filing are likely being overlooked, minimized, or misunderstood by a bullish retail crowd.
4. Do not invent facts. Only cite what is actually present in the filing text below. If a section is missing or empty, say so rather than fabricating content for it.

=== SEC FILING TEXT (${ticker}) ===
${secBlock}

5. Finally, step back and give a single bottom-line verdict for someone deciding whether to trade or hold this stock right now: does what the filing actually discloses justify the current sentiment, or is sentiment ignoring something real? Pick exactly one:
   - "favorable" — the filing's real risks are ordinary/well-managed and don't meaningfully undercut the current sentiment
   - "neutral" — mixed evidence, nothing decisive either way
   - "caution" — the filing discloses real, specific risks that the current bullish sentiment appears to be overlooking or underweighting
   - "high_risk" — the filing discloses severe or structural risk (e.g. heavy dilution exposure, liquidity dependence, concentrated revenue) that sharply contradicts the current sentiment

Respond with ONLY a JSON object matching this exact shape, no other text:
{
  "contradiction_found": true or false,
  "severity": "none" | "low" | "medium" | "high",
  "summary": "one or two sentence plain-English overview",
  "contradictions": [
    { "issue": "ONE short plain-English sentence, 20 words max — a scannable headline, not an explanation. E.g. 'Heavy reliance on a few large reinsurance clients creates concentration risk.'", "citation": "e.g. 2026 10-Q, Item 1A, paragraph on customer concentration risk", "category": "dilution" | "liquidity" | "off_balance_sheet" | "concentration" | "regulatory" | "other" }
  ],
  "dilution_risk": "1-3 short paragraphs on dilution risk to common shareholders under realistic downside scenarios, grounded in the cited sections",
  "priority_of_claims": "1-3 short paragraphs on priority of claims vs other security holders (debt, preferred, warrants) if applicable to this filing",
  "cashflow_sensitivity": "1-3 short paragraphs on earnings/cash-flow sensitivity to the identified risks",
  "verdict": "favorable" | "neutral" | "caution" | "high_risk",
  "verdict_reason": "one or two plain-English sentences on WHY this verdict, naming the specific gap (or lack of one) between the filing and the current sentiment",
  "sentiment_score": a number from 0 to 100 — echo the given score if one was provided, otherwise your own estimate derived from the crawled sentiment text,
  "confidence": a number from 0 to 1
}
Aim for 5-10 entries in "contradictions" when the filing text genuinely supports that many — do not pad with generic or repetitive entries. Each contradiction's "citation" must be distinct — do not repeat the same citation across multiple entries. If there is genuinely no meaningful tension, return fewer entries, set contradiction_found to false, severity to "none", and verdict to "favorable" or "neutral".`;

  // Confirmed via the Aug 2026 model bake-off: the primary model can hard-fail
  // (HTTP 500) on dense filings — ollamaChatWithFallback retries once against
  // CONTRADICTION_MODEL_FALLBACK rather than losing the whole analysis.
  const { data, modelUsed } = await ollamaChatWithFallback(CONTRADICTION_MODEL, CONTRADICTION_MODEL_FALLBACK, {
    messages: [{ role: 'user', content: prompt }],
    format: 'json',
    stream: false,
    // "thinking" models (e.g. qwen3-vl) write a reasoning trace to a separate
    // message.thinking field before message.content — without num_predict room for
    // BOTH, content comes back empty (done_reason: "length", confirmed live). think:
    // false asks the model to skip that trace; confirmed this Ollama/model combo still
    // sometimes writes the actual JSON into .thinking instead of .content even with
    // this set, so parsing below checks both fields rather than trusting content alone.
    think: false,
    // num_predict: the citation-based schema (up to 10 contradiction entries plus 3
    // multi-paragraph impact fields) routinely exceeds a model's default 2048-token
    // completion cap, which truncates mid-JSON — confirmed against a real run.
    options: { temperature: 0.2, num_predict: 4096 },
    // 6 min: the contradiction model can be a large, unquantized (F16) model competing
    // with CHAT_MODEL for VRAM — a cold swap-in (weights reloaded from disk) plus a
    // long-context prefill (two full filing sections) can legitimately take minutes.
  }, 360000);
  let parsed;
  try {
    parsed = JSON.parse(data.message?.content || data.message?.thinking || '{}');
  } catch (e) {
    throw new Error(`Model did not return valid JSON: ${e.message}`);
  }
  // Dedup safety net: this model occasionally repeats the same contradiction with a
  // reworded issue but an identical (or near-identical) citation — confirmed happening
  // in practice, not hypothetical. Drop repeats deterministically rather than trust the
  // model's own "citations must be distinct" instruction to always hold.
  const rawContradictions = Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  const seenCitations = new Set(), seenIssuePrefixes = new Set();
  const contradictions = rawContradictions.filter(ct => {
    const citation = String(ct?.citation || '').trim().toLowerCase();
    const issuePrefix = String(ct?.issue || '').trim().toLowerCase().slice(0, 50);
    if (!citation && !issuePrefix) return false;
    if (citation && seenCitations.has(citation)) return false;
    if (issuePrefix && seenIssuePrefixes.has(issuePrefix)) return false;
    if (citation) seenCitations.add(citation);
    if (issuePrefix) seenIssuePrefixes.add(issuePrefix);
    return true;
  });

  const VERDICTS = ['favorable', 'neutral', 'caution', 'high_risk'];
  const verdict = VERDICTS.includes(parsed.verdict) ? parsed.verdict : null;
  // score (user-supplied) wins when given; otherwise use the model's own estimate,
  // derived from the crawled sentiment text per the prompt above.
  const finalScore = score != null ? score
    : (Number.isFinite(parsed.sentiment_score) ? Math.max(0, Math.min(100, Math.round(parsed.sentiment_score))) : null);

  const info = db.prepare(`
    INSERT INTO scout_contradictions
      (ticker, sec_filing_ids, sentiment_id, contradiction_found, severity, summary,
       sentiment_score, contradictions_json, dilution_risk, priority_of_claims, cashflow_sensitivity,
       sections_used_json, verdict, verdict_reason, confidence, model_used,
       filing_tone_lm_score, filing_tone_lm_json, dilution_features_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticker, JSON.stringify(filings.map(f => f.id)), sentimentRow ? sentimentRow.id : null,
    parsed.contradiction_found ? 1 : 0, parsed.severity || 'none', parsed.summary || '',
    finalScore, JSON.stringify(contradictions), parsed.dilution_risk || '', parsed.priority_of_claims || '',
    parsed.cashflow_sensitivity || '',
    JSON.stringify(sections.map(s => ({ form_type: s.form_type, filed_at: s.filed_at, has_risk: !!s.risk, has_mda: !!s.mda }))),
    verdict, parsed.verdict_reason || '',
    Number.isFinite(parsed.confidence) ? parsed.confidence : null, modelUsed,
    filingToneLm ? filingToneLm.combined_pss_0_100 : null, filingToneLm ? JSON.stringify(filingToneLm) : null,
    dilutionFeatures ? JSON.stringify(dilutionFeatures) : null,
  );

  return {
    ok: true, id: info.lastInsertRowid, ticker,
    contradiction_found: !!parsed.contradiction_found, severity: parsed.severity || 'none', summary: parsed.summary || '',
    sentiment_score: finalScore, sentiment_score_was_estimated: score == null, sentiment_context: noSentimentContext ? 'none' : 'available',
    contradictions, dilution_risk: parsed.dilution_risk || '',
    priority_of_claims: parsed.priority_of_claims || '', cashflow_sensitivity: parsed.cashflow_sensitivity || '',
    sections_used: sections.map(s => ({ form_type: s.form_type, filed_at: s.filed_at, has_risk: !!s.risk, has_mda: !!s.mda })),
    verdict, verdict_reason: parsed.verdict_reason || '',
    confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : null, model_used: CONTRADICTION_MODEL,
    filing_tone_lm: filingToneLm, dilution_features: dilutionFeatures,
  };
}

// Read-only lookup for Plutus chat (get_truth_check tool) — surfaces the Proactive
// Scout's SEC filings on file, latest crawled sentiment, and latest Truth Check verdict
// for a ticker. Does not run anything new; if no truth check has been run yet, says so
// explicitly rather than silently returning nothing.
function toolGetTruthCheck(ticker) {
  ticker = String(ticker || '').trim().toUpperCase();
  if (!ticker) return { ok: false, reason: 'ticker is required' };

  const filings = db.prepare(`
    SELECT form_type, filed_at, description, filing_url FROM scout_sec_filings
    WHERE ticker = ? ORDER BY filed_at DESC LIMIT 5
  `).all(ticker);
  const sentimentRow = db.prepare(`
    SELECT fetched_at, content FROM scout_sentiment WHERE ticker = ? ORDER BY fetched_at DESC LIMIT 1
  `).get(ticker);
  const truthRow = db.prepare(`
    SELECT * FROM scout_contradictions WHERE ticker = ? ORDER BY analyzed_at DESC LIMIT 1
  `).get(ticker);
  const insiderRows = db.prepare(`
    SELECT transaction_date, owner_name, owner_title, owner_is_officer, owner_is_director,
           owner_is_ten_pct_owner, transaction_code_label, shares, price_per_share, acquired_disposed_code
    FROM scout_insider_filings WHERE ticker = ? ORDER BY transaction_date DESC LIMIT 5
  `).all(ticker);
  const newsRows = db.prepare(`
    SELECT headline, summary, source, url, published_at FROM scout_news
    WHERE ticker = ? ORDER BY published_at DESC LIMIT 5
  `).all(ticker);

  if (!filings.length && !sentimentRow && !truthRow && !insiderRows.length && !newsRows.length) {
    return { ok: false, reason: `No Proactive Scout data on file for ${ticker} — no SEC filings, sentiment crawl, insider activity, news, or truth check have been run yet. Direct the user to the /scout dashboard to run one, or use web_search/get_market_news for general info instead.` };
  }

  return {
    ok: true,
    data: {
      ticker,
      sec_filings_on_file: filings,
      // Structured/source-tagged, distinct from latest_sentiment below (crawled web
      // text) — Plutus should treat these as the higher-confidence SEC/API tiers per
      // the same trust-rank the osterm/scout dashboards show with source badges.
      recent_insider_activity: insiderRows,
      recent_news: newsRows,
      latest_sentiment: sentimentRow ? { fetched_at: sentimentRow.fetched_at, excerpt: (sentimentRow.content || '').slice(0, 2000) } : null,
      latest_truth_check: truthRow ? {
        analyzed_at: truthRow.analyzed_at,
        verdict: truthRow.verdict,
        verdict_reason: truthRow.verdict_reason,
        severity: truthRow.severity,
        summary: truthRow.summary,
        sentiment_score_used: truthRow.sentiment_score,
        contradictions: JSON.parse(truthRow.contradictions_json || '[]'),
        dilution_risk: truthRow.dilution_risk,
        priority_of_claims: truthRow.priority_of_claims,
        cashflow_sensitivity: truthRow.cashflow_sensitivity,
        sections_used: JSON.parse(truthRow.sections_used_json || '[]'),
        confidence: truthRow.confidence,
        model_used: truthRow.model_used,
      } : null,
    },
  };
}

app.post('/api/scout/contradiction', async (req, res) => {
  try {
    const ticker = req.body?.ticker;
    if (!ticker) return res.status(400).json({ ok: false, error: 'ticker is required' });
    const result = await runContradictionAnalysis(ticker, req.body?.sentimentScore);
    if (!result.ok) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/scout/contradiction', (req, res) => {
  try {
    const ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : null;
    const rows = db.prepare(`
      SELECT * FROM scout_contradictions
      ${ticker ? 'WHERE ticker = ?' : ''}
      ORDER BY analyzed_at DESC LIMIT 50
    `).all(...(ticker ? [ticker] : []));
    res.json({
      ok: true,
      contradictions: rows.map(r => ({
        ...r,
        contradictions: JSON.parse(r.contradictions_json || '[]'),
        sections_used: JSON.parse(r.sections_used_json || '[]'),
        sec_filing_ids: JSON.parse(r.sec_filing_ids || '[]'),
        filing_tone_lm: r.filing_tone_lm_json ? JSON.parse(r.filing_tone_lm_json) : null,
        dilution_features: r.dilution_features_json ? JSON.parse(r.dilution_features_json) : null,
      })),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── API: available date range & years ─────────────────────────────────────────
app.get('/api/date-range', (req, res) => {
  try {
    const range = db.prepare('SELECT MIN(date_iso) as min, MAX(date_iso) as max FROM trades').get();
    const years = db.prepare("SELECT DISTINCT substr(date_iso,1,4) as y FROM trades ORDER BY y DESC").all().map(r => r.y);
    res.json({ min: range.min, max: range.max, years });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: raw CSV ──────────────────────────────────────────────────────────────
app.get('/api/csv-text', (req, res) => {
  if (!fs.existsSync(CSV_FILE)) return res.status(404).send('No CSV yet');
  res.setHeader('Content-Type', 'text/plain');
  res.send(fs.readFileSync(CSV_FILE, 'utf8'));
});

// ── API: export all SQLite trades as Schwab-format CSV (for app seeding) ─────
app.get('/api/seed-db', (req, res) => {
  const rows = db.prepare('SELECT * FROM trades ORDER BY date_iso ASC').all();
  const header = 'Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount';
  const q = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map(r => [
    q(r.date_csv), q(r.action), q(r.symbol), q(r.description),
    r.quantity ?? '', r.price ?? '', r.fees ?? '', r.amount ?? '',
  ].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/plain');
  res.send(header + '\n' + csv);
});

// ── API: live account (balances + positions) ──────────────────────────────────
async function fetchLiveAccountSnapshot() {
  const token = await getAccessToken();
  const acct  = await getAccountHash(token);
  const r     = await fetch(`${API_BASE}/accounts/${acct.hash}?fields=positions`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(JSON.stringify(data));
    err.status = r.status;
    throw err;
  }

  const sa  = data.securitiesAccount || {};
  const bal = sa.currentBalances     || {};

  const positions = (sa.positions || []).map(p => {
    const isOption = p.instrument?.assetType === 'OPTION';
    // Live position instruments don't carry strikePrice/expirationDate fields
    // (unlike transaction instruments) — parse them from the description instead.
    const { strike, expiry } = isOption ? parsePositionOptionInstrument(p.instrument?.description) : { strike: null, expiry: null };
    return {
    symbol:      p.instrument?.symbol      || '—',
    description: p.instrument?.description || '',
    assetType:   p.instrument?.assetType   || '',
    putCall:     p.instrument?.putCall     || null,
    underlying:  p.instrument?.underlyingSymbol || null,
    // Used by the Greeks/expiration-calendar features (Performance Coach tab).
    strike, expiry,
    longQty:     p.longQuantity   || 0,
    shortQty:    p.shortQuantity  || 0,
    avgPrice:    p.averagePrice   || p.averageShortPrice || 0,
    marketValue: p.marketValue    || 0,
    dayPnl:      p.currentDayProfitLoss || 0,
    openPnl:     (p.longOpenProfitLoss || 0) + (p.shortOpenProfitLoss || 0),
    };
  });

  const totalDayPnl  = positions.reduce((s, p) => s + p.dayPnl,  0);
  const totalOpenPnl = positions.reduce((s, p) => s + p.openPnl, 0);

  return {
    accountNumber: acct.accountNumber,
    timestamp:     new Date().toISOString(),
    balances: {
      liquidationValue: bal.liquidationValue   || 0,
      buyingPower:      bal.buyingPower        || 0,
      cashBalance:      bal.cashBalance        || 0,
      equity:           bal.equity             || bal.liquidationValue || 0,
      marginBalance:    bal.marginBalance      || 0,
      shortOptionValue: bal.shortOptionMarketValue || 0,
      longOptionValue:  bal.longOptionMarketValue  || 0,
    },
    summary: {
      positionCount: positions.length,
      totalDayPnl,
      totalOpenPnl,
    },
    positions,
  };
}

app.get('/api/account', async (req, res) => {
  try {
    res.json(await fetchLiveAccountSnapshot());
  } catch (err) {
    const isAuthErr = /not authenticated|token|invalid_grant|unauthorized/i.test(err.message);
    const status = err.status || (isAuthErr ? 401 : 500);
    res.status(status).json({ error: err.message, needsAuth: isAuthErr });
  }
});

// ── API: single-ticker live quote (structured JSON) ───────────────────────────
// Same guard as toolGetQuote (the Plutus chat tool) — a missing price is
// reported as an explicit gap, never a fabricated $0/flat quote.
app.get('/api/quote/:ticker', async (req, res) => {
  try {
    const symbol = String(req.params.ticker || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'ticker is required' });
    const data = await schwabMarket('/quotes', { symbols: symbol, fields: 'quote,fundamental' });
    if (data.error) return res.status(502).json({ error: data.error });
    const entry = data[symbol];
    const q = entry?.quote;
    const f = entry?.fundamental || {};
    const price = q?.lastPrice ?? q?.mark;
    if (!entry || (price == null && q?.bidPrice == null && q?.askPrice == null)) {
      return res.status(404).json({ error: 'no_live_quote', message: `No live quote data available for ${symbol}.` });
    }
    // Company profile is best-effort (Finnhub, separate provider from Schwab) — a quote
    // should never fail just because the profile lookup did.
    let profile = null;
    if (process.env.FINNHUB_API_KEY) {
      try { profile = await sectors.fetchFinnhubProfile(symbol, process.env.FINNHUB_API_KEY); } catch {}
    }
    // Schwab's fundamental quote field does NOT include a 52-week range at all (confirmed
    // by inspecting the live response — no 52WkHigh/52WkLow or any equivalent key exists;
    // toolGetQuote's f['52WkHigh'] check elsewhere in this file has been silently dead code
    // this whole time). Compute it ourselves from a year of daily candles instead.
    let week52High = null, week52Low = null;
    try {
      const hist = await schwabMarket('/pricehistory', { symbol, periodType: 'year', period: 1, frequencyType: 'daily', frequency: 1 });
      const candles = hist?.candles || [];
      if (candles.length) {
        week52High = Math.max(...candles.map(c => Number(c.high || 0)).filter(Boolean));
        week52Low = Math.min(...candles.map(c => Number(c.low || Infinity)).filter(v => v !== Infinity && v > 0));
      }
    } catch {}
    res.json({
      symbol,
      price: price ?? null,
      change: q.netChange ?? 0,
      changePct: q.netPercentChange ?? 0,
      bid: q.bidPrice ?? null,
      ask: q.askPrice ?? null,
      volume: q.totalVolume ?? null,
      week52High, week52Low,
      peRatio: f.peRatio ?? null,
      divYield: f.divYield ?? null,
      profile: profile ? {
        name: profile.name || null,
        industry: profile.finnhubIndustry || null,
        exchange: profile.exchange || null,
        country: profile.country || null,
        marketCapM: profile.marketCapitalization ?? null, // Finnhub reports this in millions USD
        ipo: profile.ipo || null,
        weburl: profile.weburl || null,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: live positions (kept for compatibility) ───────────────────────────────
app.get('/api/positions', async (req, res) => {
  try {
    const snap = await fetchLiveAccountSnapshot();
    res.json(snap.positions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: recent rows from CSV ─────────────────────────────────────────────────
app.get('/api/recent', (req, res) => {
  res.json(parseCSVFile(parseInt(req.query.limit || '25', 10)));
});

// ── API: Ollama models ────────────────────────────────────────────────────────
app.get('/api/ai/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return res.json({ models: [], available: false, defaultModel: CHAT_MODEL });
    const data = await r.json();
    res.json({ models: (data.models || []).map(m => m.name), available: true, defaultModel: CHAT_MODEL });
  } catch { res.json({ models: [], available: false, defaultModel: CHAT_MODEL }); }
});

// ── API: journal — positions with full IRS tax data ───────────────────────────
app.get('/api/journal/positions', (req, res) => {
  try {
    const { year, from, to } = req.query;
    const safeFrom = from ? from.replace(/[^0-9-]/g,'') : null;
    const safeTo   = to   ? to.replace(/[^0-9-]/g,'')   : null;
    const safeYear = year ? year.replace(/\D/g,'')       : null;

    // Always include ALL legs of a position — filter by position close date (HAVING),
    // not by individual leg date (WHERE). Filtering in WHERE breaks multi-leg P&L.
    let having = '';
    if (safeYear) having += ` AND substr(MAX(t.date_iso),1,4) = '${safeYear}'`;
    if (safeFrom) having += ` AND MAX(t.date_iso) >= '${safeFrom}'`;
    if (safeTo)   having += ` AND MAX(t.date_iso) <= '${safeTo}'`;

    const positions = db.prepare(`
      SELECT t.symbol, t.underlying,
             MIN(t.date_iso) as opened, MAX(t.date_iso) as closed,
             SUM(t.amount)   as net_pnl,
             SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)        as proceeds,
             SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END)   as cost_basis,
             SUM(t.fees)     as total_fees,
             COUNT(*)        as leg_count,
             CAST(julianday(MAX(t.date_iso)) - julianday(MIN(t.date_iso)) AS INTEGER) as holding_days,
             GROUP_CONCAT(t.action || '::' || t.amount || '::' || t.date_iso || '::' || t.quantity || '::' || t.price, '||') as legs_raw,
             GROUP_CONCAT(DISTINCT t.action) as actions,
             j.strategy, j.notes, j.thesis, j.exit_reason,
             j.lessons, j.rating, j.tags, j.mistakes, j.saved_at,
             j.source, j.objective, j.market_iv_rank, j.market_support, j.market_resistance
      FROM trades t
      LEFT JOIN journal_entries j ON j.entry_id = t.symbol
      WHERE t.asset_type = 'OPTION'
      GROUP BY t.symbol
      HAVING 1=1 ${having}
      ORDER BY MAX(t.date_iso) DESC
    `).all();

    // Wash sale detection: flag loss positions where same underlying traded within ±30 days
    const allTrades = db.prepare(`
      SELECT underlying, date_iso, action, amount FROM trades WHERE asset_type='OPTION'
    `).all();

    const positions2 = positions.map(p => {
      const term = p.holding_days < 366 ? 'short' : 'long';
      let wash_sale = false;
      if ((p.net_pnl || 0) < 0) {
        const closeDate = new Date(p.closed);
        const win30 = allTrades.filter(t =>
          t.underlying === p.underlying &&
          t.date_iso !== p.closed &&
          Math.abs(new Date(t.date_iso) - closeDate) <= 30 * 86400000 &&
          (t.action === 'Sell to Open' || t.action === 'Buy to Open')
        );
        wash_sale = win30.length > 0;
      }
      // Parse legs for display
      const legs = (p.legs_raw || '').split('||').map(l => {
        const [action, amount, date, qty, price] = l.split('::');
        return { action, amount: parseFloat(amount), date, qty: parseFloat(qty), price: parseFloat(price) };
      });
      return { ...p, term, wash_sale, legs };
    });

    res.json(positions2);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: journal — Form 8949 data ─────────────────────────────────────────────
app.get('/api/journal/form8949', (req, res) => {
  try {
    const { year, from, to } = req.query;
    const safeFrom = from ? from.replace(/[^0-9-]/g,'') : null;
    const safeTo   = to   ? to.replace(/[^0-9-]/g,'')   : null;
    const safeYear = year ? year.replace(/\D/g,'')       : null;

    let having = 'COUNT(*) > 0';
    if (safeYear) having += ` AND substr(MAX(t.date_iso),1,4) = '${safeYear}'`;
    if (safeFrom) having += ` AND MAX(t.date_iso) >= '${safeFrom}'`;
    if (safeTo)   having += ` AND MAX(t.date_iso) <= '${safeTo}'`;

    const rows = db.prepare(`
      SELECT t.symbol, t.underlying,
             MIN(t.date_iso) as date_acquired, MAX(t.date_iso) as date_sold,
             SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as proceeds,
             SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as cost_basis,
             SUM(t.amount) as net_pnl, SUM(t.fees) as total_fees,
             CAST(julianday(MAX(t.date_iso)) - julianday(MIN(t.date_iso)) AS INTEGER) as holding_days,
             GROUP_CONCAT(DISTINCT t.action) as actions
      FROM trades t
      WHERE t.asset_type = 'OPTION'
      GROUP BY t.symbol HAVING ${having}
      ORDER BY MAX(t.date_iso) ASC
    `).all();

    const allTrades = db.prepare(`SELECT underlying, date_iso, action FROM trades WHERE asset_type='OPTION'`).all();

    const form = rows.map(r => {
      const term = r.holding_days < 366 ? 'short' : 'long';
      let ws_adj = 0;
      if ((r.net_pnl || 0) < 0) {
        const closeDate = new Date(r.date_sold);
        const win30 = allTrades.filter(t =>
          t.underlying === r.underlying && t.date_iso !== r.date_sold &&
          Math.abs(new Date(t.date_iso) - closeDate) <= 30 * 86400000 &&
          (t.action === 'Sell to Open' || t.action === 'Buy to Open')
        );
        if (win30.length > 0) ws_adj = Math.abs(r.net_pnl); // disallow full loss
      }
      return {
        description:    r.symbol,
        underlying:     r.underlying,
        date_acquired:  r.date_acquired,
        date_sold:      r.date_sold,
        proceeds:       +(r.proceeds  || 0).toFixed(2),
        cost_basis:     +(r.cost_basis || 0).toFixed(2),
        ws_adjustment:  +ws_adj.toFixed(2),
        gain_loss:      +((r.net_pnl || 0) + ws_adj).toFixed(2),
        net_pnl:        +(r.net_pnl   || 0).toFixed(2),
        total_fees:     +(r.total_fees || 0).toFixed(2),
        holding_days:   r.holding_days,
        term,
        actions:        r.actions,
      };
    });
    res.json(form);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: journal — Form 8949 CSV export ───────────────────────────────────────
app.get('/api/journal/export', (req, res) => {
  try {
    const { year, from, to } = req.query;
    const data = JSON.parse(JSON.stringify(
      (() => {
        const safeFrom = from ? from.replace(/[^0-9-]/g,'') : null;
        const safeTo   = to   ? to.replace(/[^0-9-]/g,'')   : null;
        const safeYear = year ? year.replace(/\D/g,'')       : null;
        let having = 'COUNT(*) > 0';
        if (safeYear) having += ` AND substr(MAX(t.date_iso),1,4) = '${safeYear}'`;
        if (safeFrom) having += ` AND MAX(t.date_iso) >= '${safeFrom}'`;
        if (safeTo)   having += ` AND MAX(t.date_iso) <= '${safeTo}'`;
        return db.prepare(`
          SELECT t.symbol, t.underlying,
                 MIN(t.date_iso) as date_acquired, MAX(t.date_iso) as date_sold,
                 SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as proceeds,
                 SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as cost_basis,
                 SUM(t.amount) as net_pnl, SUM(t.fees) as fees,
                 CAST(julianday(MAX(t.date_iso)) - julianday(MIN(t.date_iso)) AS INTEGER) as days
          FROM trades t
          WHERE t.asset_type = 'OPTION'
          GROUP BY t.symbol HAVING ${having}
          ORDER BY MAX(t.date_iso) ASC
        `).all();
      })()
    ));
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = 'Description,Date Acquired,Date Sold or Disposed,Proceeds,Cost or Other Basis,Adjustment,Gain or Loss,Term,Fees';
    const lines  = data.map(r => {
      const term = r.days < 366 ? 'Short-Term' : 'Long-Term';
      return [q(r.symbol), q(r.date_acquired), q(r.date_sold),
              r.proceeds.toFixed(2), r.cost_basis.toFixed(2), '0.00',
              r.net_pnl.toFixed(2), term, r.fees.toFixed(2)].join(',');
    });
    const suffix = from ? `_${from}_${to||'today'}` : year ? '-' + year : '';
    const filename = `form8949${suffix}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(header + '\n' + lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: import trades from CSV or JSON ──────────────────────────────────────
app.post('/api/import', (req, res) => {
  try {
    const { content, format = 'csv' } = req.body;
    if (!content) return res.status(400).json({ error: 'No content provided' });

    let rows = [];

    if (format === 'csv') {
      const parsed = parseCSVToRows(content);
      rows = parsed.map(r => {
        const isOption = /\d{2}\/\d{2}\/\d{4}/.test(r.Symbol);
        const dateIso  = mmddyyyyToISO(r.Date);
        if (!dateIso) return null;
        return [
          r.Date, dateIso, r.Action, r.Symbol,
          extractUnderlying(r.Symbol), isOption ? 'OPTION' : 'EQUITY',
          r.Description || '',
          parseFloat(r.Quantity) || 0,
          parseFloat(r.Price)    || 0,
          parseFloat(r['Fees & Comm']) || 0,
          parseFloat(r.Amount)   || 0,
          null, // time_iso — plain CSV has no time-of-day component
        ];
      }).filter(Boolean);

    } else if (format === 'json') {
      let parsed = typeof content === 'string' ? JSON.parse(content) : content;

      // Unwrap Schwab's object envelope — try known wrapper keys first, then any array value
      if (!Array.isArray(parsed)) {
        const KNOWN_KEYS = ['BrokerageTransactions', 'transactions', 'Transactions', 'data', 'items', 'trades'];
        const found = KNOWN_KEYS.find(k => Array.isArray(parsed[k]));
        if (found) {
          parsed = parsed[found];
        } else {
          // last resort: grab the first array-valued property
          const firstArr = Object.values(parsed).find(v => Array.isArray(v));
          if (firstArr) parsed = firstArr;
          else return res.status(400).json({ error: 'Could not find a transaction array in the JSON. Expected a bare array or an object with a "BrokerageTransactions" / "transactions" key.' });
        }
      }

      rows = parsed.map(r => {
        // ── Schwab API format (has transferItems) → run through convertTxn ──
        if (r.transferItems) {
          const converted = convertTxn(r);
          if (!converted) return null;
          r = converted; // fall through to the CSV-shape handler below
        }

        // Support both CSV-column names and friendlier camelCase
        const date   = r.Date   || r.date   || r.tradeDate   || r.settlementDate || '';
        const action = r.Action || r.action || '';
        const symbol = r.Symbol || r.symbol || '';
        if (!date || !action || !symbol) return null;
        const isOption = /\d{2}\/\d{2}\/\d{4}/.test(symbol);
        const dateIso  = /^\d{4}-/.test(date) ? date.slice(0,10) : mmddyyyyToISO(date);
        if (!dateIso) return null;
        return [
          date, dateIso, action, symbol,
          r.underlying || r._underlying || extractUnderlying(symbol),
          r.assetType || r.asset_type || r._assetType || (isOption ? 'OPTION' : 'EQUITY'),
          r.Description || r.description || '',
          parseFloat(r.Quantity || r.quantity) || 0,
          parseFloat(r.Price    || r.price)    || 0,
          parseFloat(r['Fees & Comm'] || r.fees) || 0,
          parseFloat(r.Amount   || r.amount)   || 0,
          r._timeIso || null, // set by convertTxn() when importing raw Schwab JSON
        ];
      }).filter(Boolean);
    } else {
      return res.status(400).json({ error: 'format must be "csv" or "json"' });
    }

    if (!rows.length) return res.json({ ok: true, inserted: 0, message: 'No valid rows found' });

    const before = db.prepare('SELECT COUNT(*) as n FROM trades').get().n;
    stmtInsertMany(rows);
    const after  = db.prepare('SELECT COUNT(*) as n FROM trades').get().n;
    const inserted = after - before;

    if (inserted > 0) {
      autoJournalNewPositions(CHAT_MODEL).catch(e => console.error('❌  Auto-journal error:', e.message));
    }

    res.json({ ok: true, inserted, total: after, skipped: rows.length - inserted,
               message: `Imported ${inserted} new rows (${rows.length - inserted} duplicates skipped)` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: journal — save full journal entry ────────────────────────────────────
app.post('/api/journal/save', (req, res) => {
  try {
    const result = saveJournalEntry(req.body || {});
    if (result.startsWith('ERROR:')) return res.status(400).json({ error: result });
    const entryId = String(result.match(/entry_id:\s*(.+)/)?.[1] || '');
    res.json({ ok: true, entryId, message: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: apply a model-proposed correction to an EXISTING journal entry ──────
// The only place that actually writes one of these corrections — reachable
// only via explicit user approval in the UI, never automatically from chat.
app.post('/api/journal/apply-correction', (req, res) => {
  try {
    const { id, field, proposed_value } = req.body || {};
    if (!CORRECTION_FIELDS.includes(field)) {
      return res.status(400).json({ error: `field must be one of: ${CORRECTION_FIELDS.join(', ')}` });
    }
    const numId = Number(id);
    if (!Number.isFinite(numId)) return res.status(400).json({ error: 'id is required.' });
    const info = db.prepare(`UPDATE journal_entries SET ${field} = ? WHERE id = ?`).run(String(proposed_value ?? ''), numId);
    if (!info.changes) return res.status(404).json({ error: `No journal_entries row with id ${numId}.` });
    // Re-index so RAG stops surfacing the now-stale embedded text for this entry
    rag.indexAll(db, OLLAMA_HOST, EMBED_MODEL).catch(e => console.error('RAG re-index after correction failed:', e.message));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: RAG status ───────────────────────────────────────────────────────────
app.get('/api/rag/status', (req, res) => {
  try { res.json({ ...rag.getStatus(db), embedModel: EMBED_MODEL, chatModel: CHAT_MODEL }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: RAG index (trigger) ──────────────────────────────────────────────────
app.post('/api/rag/index', async (req, res) => {
  const state = rag.getIndexState();
  if (state.running) return res.json({ ok: false, reason: 'Already indexing', state });
  // Run async, respond immediately
  rag.indexAll(db, OLLAMA_HOST, EMBED_MODEL).catch(e => console.error('RAG index error:', e));
  res.json({ ok: true, message: `Indexing started using embed model: ${EMBED_MODEL}` });
});

// ── API: RAG index progress ───────────────────────────────────────────────────
app.get('/api/rag/progress', (req, res) => {
  res.json(rag.getIndexState());
});

// ── API: receive journal entries from browser ─────────────────────────────────
app.post('/api/journal', (req, res) => {
  try {
    const { entries = [] } = req.body;
    if (!entries.length) return res.json({ ok: true, saved: 0 });
    const saved = rag.saveJournalEntries(db, entries);
    res.json({ ok: true, saved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Ollama web search helper ──────────────────────────────────────────────────
async function ollamaWebSearch(query) {
  if (!OLLAMA_API_KEY) return null;
  try {
    const r = await fetch('https://ollama.com/api/web_search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OLLAMA_API_KEY}` },
      body:    JSON.stringify({ query }),
      signal:  AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const results = (data.results || []).slice(0, 5);
    if (!results.length) return null;
    return results.map(r => `**${r.title}**\n${r.url}\n${r.content || ''}`).join('\n\n---\n\n');
  } catch { return null; }
}

// Perplexity sonar — real-time web search, returns grounded answer + citations.
// opts.domains restricts results to a curated allow-list (Perplexity's search_domain_filter,
// max 10 entries); opts.recency restricts to a time window ('day'|'week'|'month'|'year').
async function perplexitySearch(query, opts = {}) {
  if (!PERPLEXITY_API_KEY) return null;
  try {
    const body = { model: 'sonar', messages: [{ role: 'user', content: query }], max_tokens: 1024 };
    if (opts.domains?.length) body.search_domain_filter = opts.domains.slice(0, 10);
    if (opts.recency) body.search_recency_filter = opts.recency;
    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PERPLEXITY_API_KEY}` },
      body:    JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const content   = data.choices?.[0]?.message?.content;
    const citations = data.citations || [];
    if (!content) return null;
    const citeStr = citations.length
      ? '\n\nSources: ' + citations.slice(0, 5).join(' | ')
      : '';
    return `[Perplexity] ${content}${citeStr}`;
  } catch { return null; }
}

// Run both search providers in parallel, return best available result
async function webSearch(query) {
  const [perp, olla] = await Promise.all([perplexitySearch(query), ollamaWebSearch(query)]);
  if (perp && olla) return `${perp}\n\n---\n\n[Ollama Search]\n${olla}`;
  return perp || olla || null;
}

// Sentiment Crawler only: restricted to reputable financial news/analysis outlets instead
// of unrestricted web search, which surfaced unverifiable reddit/twitter chatter as
// "sentiment." Perplexity's search_domain_filter enforces this directly; Ollama's hosted
// web_search API has no confirmed equivalent param, so its query names the same outlets
// explicitly to steer results the same way.
const SENTIMENT_SOURCES = [
  'reuters.com', 'bloomberg.com', 'wsj.com', 'cnbc.com', 'marketwatch.com',
  'barrons.com', 'seekingalpha.com', 'fool.com', 'benzinga.com', 'stocktwits.com',
];
async function sentimentWebSearch(ticker) {
  const perpQuery = `${ticker} stock investor sentiment and analyst commentary this week`;
  const ollaQuery = `${ticker} stock sentiment this week — Reuters, Bloomberg, WSJ, CNBC, MarketWatch, Barron's, Seeking Alpha, Motley Fool, Benzinga, StockTwits`;
  const [perp, olla] = await Promise.all([
    perplexitySearch(perpQuery, { domains: SENTIMENT_SOURCES, recency: 'week' }),
    ollamaWebSearch(ollaQuery),
  ]);
  if (perp && olla) return `${perp}\n\n---\n\n[Ollama Search]\n${olla}`;
  return perp || olla || null;
}

// Purpose-built financial news search — formats the query for maximum relevance
async function getMarketNews(ticker, dateFrom, dateTo, topic) {
  const period = dateTo && dateTo !== dateFrom ? `${dateFrom} to ${dateTo}` : dateFrom;
  const focus  = topic ? ` ${topic}` : ' earnings catalyst analyst price movement';
  const query  = `${ticker} stock news${focus} ${period} market impact what happened`;
  return await perplexitySearch(query) || await ollamaWebSearch(query) || null;
}

// ── Schwab Market Data helpers ────────────────────────────────────────────────
async function schwabMarket(path, params = {}) {
  try {
    const token = await getAccessToken();
    const url   = new URL(`${MARKET_BASE}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const r = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
      signal:  AbortSignal.timeout(10000),
    });
    if (!r.ok) return { error: `Schwab market API ${r.status}` };
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

async function toolGetQuote(symbols) {
  const data = await schwabMarket('/quotes', { symbols, fields: 'quote,fundamental' });
  if (data.error) return `Error fetching quotes: ${data.error}`;
  const requested = String(symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  const invalid = data.errors?.invalidSymbols || [];
  const quoteEntries = Object.entries(data).filter(([sym]) => sym !== 'errors');
  if (!quoteEntries.length) {
    const bad = invalid.length ? invalid.join(', ') : (requested.join(', ') || 'the requested symbol(s)');
    return `NO QUOTE DATA: Schwab returned nothing for ${bad} — do not assume a price; treat as unavailable.`;
  }
  const lines = ['REAL-TIME QUOTES:'];
  if (invalid.length) lines.push(`(no data for: ${invalid.join(', ')} — do not report a price for ${invalid.length > 1 ? 'these' : 'this'})`);
  for (const [sym, v] of quoteEntries) {
    const q = v.quote || {};
    const f = v.fundamental || {};
    const price = q.lastPrice ?? q.mark;
    // A missing price (not just a $0 one) means Schwab has no usable quote for
    // this symbol right now — surface that explicitly rather than rendering
    // "$?"/"0.00%", which reads to the model (and the user) as a real, flat
    // quote instead of a data gap. Same "don't paper over a gap" policy as
    // has_incomplete_pricing/past_expiry_unclosed in positionEngine.js.
    if (price == null && q.bidPrice == null && q.askPrice == null) {
      lines.push(`${sym}: NO LIVE QUOTE DATA AVAILABLE — do not report a price, bid, ask, or % change for this symbol.`);
      continue;
    }
    const chg    = q.netChange ?? 0;
    const chgPct = q.netPercentChange ?? 0;
    const dir    = chg >= 0 ? '▲' : '▼';
    lines.push(
      `${sym}: $${price ?? '?'} ${dir}${chgPct.toFixed(2)}% (${chg >= 0 ? '+' : ''}${chg.toFixed(2)})` +
      ` | Bid $${q.bidPrice ?? '?'} / Ask $${q.askPrice ?? '?'}` +
      ` | Vol ${q.totalVolume ? (q.totalVolume/1e6).toFixed(2)+'M' : '?'}` +
      (f.peRatio ? ` | P/E ${f.peRatio.toFixed(1)}` : '')
      // No 52-week range here: Schwab's fundamental quote field doesn't return one at all
      // (confirmed live) — this used to check a key (f['52WkHigh']) that never exists, so
      // it silently never displayed anything. get_price_history is the real way to get
      // 52-week range if the model needs it; not worth an extra API call on every quote.
    );
  }
  return lines.join('\n');
}

async function toolGetOptionsChain(symbol, contractType = 'ALL', strikeCount = 8, expDateFrom, expDateTo) {
  const params = { symbol, contractType, strikeCount: String(strikeCount), includeUnderlyingQuote: 'true' };
  if (expDateFrom) params.fromDate = expDateFrom;
  if (expDateTo)   params.toDate   = expDateTo;
  const data = await schwabMarket('/chains', params);
  if (data.error) return `Error fetching options chain: ${data.error}`;

  const ul = data.underlyingPrice ?? data.underlying?.mark ?? '?';
  // Schwab's /chains volatility fields (top-level and per-contract) are already
  // percentage-scale numbers (e.g. 242.029 means 242.029%), not 0-1 fractions —
  // confirmed directly against the live API. _normalizeIvPct already encodes
  // this exact rule elsewhere in the file; reuse it instead of a flat *100.
  const ivNorm = _normalizeIvPct(data.volatility);
  const iv = ivNorm != null ? `${ivNorm.toFixed(1)}%` : '?';
  const lines = [`OPTIONS CHAIN: ${symbol} | Underlying $${typeof ul === 'number' ? ul.toFixed(2) : ul} | IV ${iv}`];

  const fmtLegs = (map, side) => {
    if (!map) return;
    for (const [exp, strikes] of Object.entries(map).slice(0, 4)) {
      lines.push(`\n${side} — Expiry ${exp}:`);
      lines.push('  Strike   | Bid   | Ask   | Delta  | IV     | OI     | Vol');
      for (const [strike, contracts] of Object.entries(strikes)) {
        const c = Array.isArray(contracts) ? contracts[0] : contracts;
        lines.push(
          `  ${parseFloat(strike).toFixed(2).padStart(8)} | ` +
          `${(c.bid??0).toFixed(2).padStart(5)} | ` +
          `${(c.ask??0).toFixed(2).padStart(5)} | ` +
          `${(c.delta??0).toFixed(3).padStart(6)} | ` +
          `${(_normalizeIvPct(c.volatility) ?? 0).toFixed(1).padStart(5)}% | ` +
          `${String(c.openInterest??0).padStart(6)} | ` +
          `${String(c.totalVolume??0).padStart(6)}`
        );
      }
    }
  };
  fmtLegs(data.callExpDateMap, 'CALLS');
  fmtLegs(data.putExpDateMap,  'PUTS');
  return lines.join('\n');
}

async function toolGetPriceHistory(symbol, period = 1, periodType = 'month', frequencyType = 'daily', frequency = 1) {
  const data = await schwabMarket('/pricehistory', { symbol, periodType, period, frequencyType, frequency, needExtendedHoursData: false });
  if (data.error) return `Error fetching price history: ${data.error}`;
  const candles = (data.candles || []).slice(-60);
  if (!candles.length) return `No price history found for ${symbol}`;
  const labels = candles.map(c => new Date(c.datetime).toISOString().slice(0, 10));
  const closes = candles.map(c => c.close);
  // Return both text summary and a chart spec
  const first = candles[0], last = candles[candles.length - 1];
  const chgPct = ((last.close - first.close) / first.close * 100).toFixed(2);
  const hi = Math.max(...candles.map(c => c.high)).toFixed(2);
  const lo = Math.min(...candles.map(c => c.low)).toFixed(2);
  const avgVol = (candles.reduce((s, c) => s + c.volume, 0) / candles.length / 1e6).toFixed(2);
  return [
    `PRICE HISTORY: ${symbol} (${periodType} ${period}, ${frequencyType} ${frequency})`,
    `Period: ${labels[0]} → ${labels[labels.length-1]}`,
    `Change: ${chgPct >= 0 ? '+' : ''}${chgPct}% | Range $${lo}–$${hi} | Avg Vol ${avgVol}M`,
    `\nTo chart this, output:\n\`\`\`chart\n${JSON.stringify({type:'line',title:`${symbol} Price (${period}${periodType[0]})`,labels,data:closes,prefix:'$'})}\n\`\`\``,
  ].join('\n');
}

// ── FINRA daily short-sale volume (official public data — the same underlying
// numbers sites like shortvolume.com chart, pulled directly from FINRA instead
// of scraping a third-party chart image, which is blocked/not machine-readable
// there anyway). One file per calendar day covers every symbol, so it's cached
// in-memory per process rather than re-fetched per ticker query.
const _finraShortVolCache = new Map(); // 'YYYYMMDD' -> Map(symbol -> {shortVolume, totalVolume}) | null
async function _fetchFinraShortVolDay(dateStr) {
  if (_finraShortVolCache.has(dateStr)) return _finraShortVolCache.get(dateStr);
  try {
    const r = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { _finraShortVolCache.set(dateStr, null); return null; }
    const text = await r.text();
    const bySymbol = new Map();
    const lines = text.trim().split('\n');
    for (let i = 1; i < lines.length; i++) { // line 0 is the header
      const parts = lines[i].split('|');
      const symbol = parts[1];
      if (!symbol) continue;
      bySymbol.set(symbol, { shortVolume: parseFloat(parts[2]) || 0, totalVolume: parseFloat(parts[4]) || 0 });
    }
    _finraShortVolCache.set(dateStr, bySymbol);
    return bySymbol;
  } catch (e) {
    _finraShortVolCache.set(dateStr, null);
    return null;
  }
}

async function toolGetShortVolume(symbol, days = 5) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return 'ERROR: symbol is required.';
  const wantDays = Math.max(1, Math.min(30, Number(days) || 5));
  const results = [];
  const cursor = new Date();
  let attempts = 0;
  // Pad the walk-back window past wantDays so weekends/market holidays (which
  // have no published FINRA file) don't shrink the requested trading-day count.
  while (results.length < wantDays && attempts < wantDays + 15) {
    attempts++;
    const dow = cursor.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) {
      const dateStr = cursor.toISOString().slice(0, 10).replace(/-/g, '');
      const dayData = await _fetchFinraShortVolDay(dateStr);
      const row = dayData?.get(sym);
      if (row) {
        const pct = row.totalVolume > 0 ? (row.shortVolume / row.totalVolume) * 100 : null;
        results.push({ date: cursor.toISOString().slice(0, 10), ...row, pct });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  if (!results.length) {
    return `NO SHORT-VOLUME DATA: FINRA has no data for ${sym} in the recent trading days checked — it may not be FINRA-reportable, may be delisted, or may be too newly listed.`;
  }
  const avgPct = results.reduce((s, r) => s + (r.pct || 0), 0) / results.length;
  const lines = [`SHORT SALE VOLUME (FINRA official): ${sym} — last ${results.length} trading day(s), most recent first`];
  results.forEach(r => lines.push(
    `  ${r.date}: ${r.pct != null ? r.pct.toFixed(1) + '%' : '?'} short  (short vol ${Math.round(r.shortVolume).toLocaleString()} / total vol ${Math.round(r.totalVolume).toLocaleString()})`
  ));
  lines.push(`Average over period: ${avgPct.toFixed(1)}%`);
  lines.push('IMPORTANT: this is daily short SALE volume (% of that day\'s trading volume that was a short sale) — a flow/activity metric, NOT "short interest" (total shares currently sold short, reported biweekly). Do not use these numbers interchangeably or describe this as "% of float sold short."');
  return lines.join('\n');
}

async function toolGetMarketMovers(index = '$SPX') {
  const data = await schwabMarket(`/movers/${encodeURIComponent(index)}`, { sort: 'PERCENT_CHANGE_UP', frequency: 0 });
  if (data.error) return `Error fetching movers: ${data.error}`;
  const items = Array.isArray(data) ? data : (data.screeners || data.movers || []);
  if (!items.length) return 'No mover data available.';
  const lines = [`TOP MOVERS (${index}):`];
  items.slice(0, 10).forEach((m, i) => {
    const chg = (m.netChange ?? m.change ?? 0).toFixed(2);
    const pct = (m.netPercentChange ?? m.percentChange ?? 0).toFixed(2);
    lines.push(`${i+1}. ${m.symbol} $${(m.last ?? m.close ?? 0).toFixed(2)} ${pct >= 0 ? '▲' : '▼'}${Math.abs(pct)}% (${chg >= 0 ? '+' : ''}${chg}) Vol ${m.totalVolume ? (m.totalVolume/1e6).toFixed(1)+'M' : '?'}`);
  });
  return lines.join('\n');
}

async function toolGetMarketHours() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = await schwabMarket('/markets', { markets: 'equity,option', date: today });
  if (data.error) return `Error: ${data.error}`;
  const lines = ['MARKET HOURS TODAY:'];
  for (const [mkt, sessions] of Object.entries(data)) {
    for (const [, info] of Object.entries(sessions || {})) {
      lines.push(`${mkt.toUpperCase()}: ${info.isOpen ? '✅ OPEN' : '❌ CLOSED'} | ${info.sessionHours?.regularMarket?.[0]?.start ?? '?'} – ${info.sessionHours?.regularMarket?.[0]?.end ?? '?'}`);
    }
  }
  return lines.join('\n');
}

// Read-only SQL query against the trades DB — used by the query_trades tool
function queryTrades(sql) {
  const clean = sql.trim().toUpperCase();
  if (!clean.startsWith('SELECT')) return 'ERROR: Only SELECT queries are allowed.';
  // Block any attempt to modify data
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA)\b/.test(clean)) {
    return 'ERROR: Only read-only SELECT queries are permitted.';
  }
  try {
    const rows = db.prepare(sql).all();
    if (!rows.length) return 'Query returned 0 rows.';
    const limited = rows.slice(0, 100);
    const header  = Object.keys(limited[0]).join(' | ');
    const divider = header.replace(/[^|]/g, '-').replace(/\|/g, '+');
    const body    = limited.map(r => Object.values(r).map(v => v == null ? 'NULL' : String(v)).join(' | ')).join('\n');
    const note    = rows.length > 100 ? `\n(showing first 100 of ${rows.length} rows)` : '';
    return `${header}\n${divider}\n${body}${note}`;
  } catch (err) {
    return `SQL ERROR: ${err.message}`;
  }
}

// ── Query Vault helpers (intent -> validated SQL memory) ─────────────────────
// Fuzzy match uses Dice's coefficient over character bigrams — no external
// dependency, same technique the popular `string-similarity` npm package
// uses under the hood. Good enough for short phrase-vs-phrase intent matching.
function vaultBigrams(str) {
  const s = String(str).toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}
function vaultSimilarity(a, b) {
  const gramsA = vaultBigrams(a), gramsB = vaultBigrams(b);
  if (!gramsA.length || !gramsB.length) {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase() ? 1 : 0;
  }
  const counts = new Map();
  for (const g of gramsA) counts.set(g, (counts.get(g) || 0) + 1);
  let matches = 0;
  for (const g of gramsB) {
    const c = counts.get(g) || 0;
    if (c > 0) { matches++; counts.set(g, c - 1); }
  }
  return (2 * matches) / (gramsA.length + gramsB.length);
}

// Record a query_trades SQL string that ran successfully for a given intent.
// Upserts on exact intent match (bumps success_count + refreshes sql_query),
// otherwise inserts a new row.
function recordVaultSuccess(intent, sql) {
  intent = String(intent || '').trim();
  sql = String(sql || '').trim();
  if (!intent || !sql) return null;
  const existing = db.prepare('SELECT id FROM query_vault WHERE intent = ?').get(intent);
  if (existing) {
    db.prepare(`
      UPDATE query_vault
      SET success_count = success_count + 1, last_used = datetime('now'), sql_query = ?
      WHERE id = ?
    `).run(sql, existing.id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO query_vault (intent, sql_query, last_used)
    VALUES (?, ?, datetime('now'))
  `).run(intent, sql);
  return info.lastInsertRowid;
}

// Find past vault entries whose intent is similar to `intent`, best first.
function matchVaultIntent(intent, { topN = 1, threshold = 0.35 } = {}) {
  intent = String(intent || '').trim();
  if (!intent) return [];
  const rows = db.prepare('SELECT * FROM query_vault').all();
  return rows
    .map(row => ({ ...row, match_score: Math.round(vaultSimilarity(intent, row.intent) * 1000) / 1000 }))
    .filter(row => row.match_score >= threshold)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, topN);
}

function listVaultEntries(limit = 50, offset = 0) {
  return db.prepare(`
    SELECT * FROM query_vault
    ORDER BY success_count DESC, last_used DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function deleteVaultEntry(id) {
  const info = db.prepare('DELETE FROM query_vault WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

function buildTradingStyleProfile() {
  const totalOptionRows = db.prepare("SELECT COUNT(*) as n FROM trades WHERE asset_type='OPTION'").get().n || 0;
  if (!totalOptionRows) return 'No options history yet to infer trading style.';

  const openActs = db.prepare(`
    SELECT
      SUM(CASE WHEN action='Sell to Open' THEN 1 ELSE 0 END) as sto,
      SUM(CASE WHEN action='Buy to Open'  THEN 1 ELSE 0 END) as bto,
      SUM(CASE WHEN action='Sell to Open' AND symbol LIKE '% P' THEN 1 ELSE 0 END) as sto_put,
      SUM(CASE WHEN action='Sell to Open' AND symbol LIKE '% C' THEN 1 ELSE 0 END) as sto_call,
      SUM(CASE WHEN action='Buy to Open'  AND symbol LIKE '% P' THEN 1 ELSE 0 END) as bto_put,
      SUM(CASE WHEN action='Buy to Open'  AND symbol LIKE '% C' THEN 1 ELSE 0 END) as bto_call
    FROM trades
    WHERE asset_type='OPTION'
  `).get();

  const byDOW = db.prepare(`
    SELECT strftime('%w', date_iso) as dow, AVG(amount) as avg_pnl, COUNT(*) as n
    FROM trades
    WHERE asset_type='OPTION'
    GROUP BY dow
  `).all();

  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const bestDow = byDOW.filter(r => r.n >= 20).sort((a, b) => b.avg_pnl - a.avg_pnl)[0];
  const worstDow = byDOW.filter(r => r.n >= 20).sort((a, b) => a.avg_pnl - b.avg_pnl)[0];

  const closed = db.prepare(`
    SELECT symbol, SUM(amount) as net_pnl,
           SUM(CASE WHEN action='Sell to Open' THEN 1 ELSE 0 END) as sto,
           SUM(CASE WHEN action='Buy to Open'  THEN 1 ELSE 0 END) as bto
    FROM trades
    WHERE asset_type='OPTION'
    GROUP BY symbol
  `).all();

  const soldPremium = closed.filter(p => p.sto > 0);
  const boughtPremium = closed.filter(p => p.bto > 0);

  const wr = rows => {
    const eligible = rows.filter(r => r.net_pnl !== 0);
    if (!eligible.length) return 0;
    const wins = eligible.filter(r => r.net_pnl > 0).length;
    return (wins / eligible.length) * 100;
  };

  const sto = openActs.sto || 0;
  const bto = openActs.bto || 0;
  const totalOpen = sto + bto || 1;
  const styleLabel =
    sto / totalOpen >= 0.7 ? 'Premium seller bias' :
    bto / totalOpen >= 0.7 ? 'Premium buyer bias'  :
    'Mixed premium seller/buyer';

  return [
    `TRADING STYLE PROFILE: ${styleLabel}`,
    `- Open-flow split: STO ${((sto / totalOpen) * 100).toFixed(1)}% | BTO ${((bto / totalOpen) * 100).toFixed(1)}%`,
    `- Put/Call bias (openers): STO puts ${openActs.sto_put || 0}, STO calls ${openActs.sto_call || 0}, BTO puts ${openActs.bto_put || 0}, BTO calls ${openActs.bto_call || 0}`,
    `- Position win rate by style: sold premium ${wr(soldPremium).toFixed(1)}% | bought premium ${wr(boughtPremium).toFixed(1)}%`,
    bestDow ? `- Best weekday edge (avg option cashflow): ${dowNames[Number(bestDow.dow)]} (${Number(bestDow.avg_pnl).toFixed(2)} avg, n=${bestDow.n})` : '- Best weekday edge: insufficient sample',
    worstDow ? `- Weakest weekday edge (avg option cashflow): ${dowNames[Number(worstDow.dow)]} (${Number(worstDow.avg_pnl).toFixed(2)} avg, n=${worstDow.n})` : '- Weakest weekday edge: insufficient sample',
  ].join('\n');
}

function normalizeJournalDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function saveJournalEntry({
  date, symbol, underlying, action, strategy = '', notes = '', thesis = '', exit_reason = '',
  lessons = '', rating = 0, tags = '', mistakes = '',
  source = 'manual', objective = '', market_iv_rank = null, market_support = null,
  market_resistance = null, legs_at_save = null, entryIdOverride = null,
}) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  if (!cleanSymbol) return 'ERROR: symbol is required.';

  const dateISO = normalizeJournalDate(date);
  if (date && !dateISO) return 'ERROR: date must be YYYY-MM-DD or MM/DD/YYYY.';

  const cleanUnderlying = String(underlying || '').trim().toUpperCase() || null;
  const cleanAction = String(action || '').trim() || null;
  const cleanStrategy = String(strategy || '').trim();
  const cleanNotes = String(notes || '').trim();
  const cleanThesis = String(thesis || '').trim();
  const cleanExitReason = String(exit_reason || '').trim();
  const cleanLessons = String(lessons || '').trim();
  const cleanTags = String(tags || '').trim();
  const cleanMistakes = String(mistakes || '').trim();
  const safeRating = Number.isFinite(+rating) ? Math.max(0, Math.min(10, Math.round(+rating))) : 0;
  const cleanSource = String(source || 'manual').trim() || 'manual';
  const cleanObjective = String(objective || '').trim();
  const safeIvRank = Number.isFinite(+market_iv_rank) ? +market_iv_rank : null;
  const safeSupport = Number.isFinite(+market_support) ? +market_support : null;
  const safeResistance = Number.isFinite(+market_resistance) ? +market_resistance : null;
  const safeLegsAtSave = Number.isFinite(+legs_at_save) ? +legs_at_save : null;
  const entryId = entryIdOverride || [dateISO || 'undated', cleanSymbol, cleanAction || 'journal'].join('::');

  db.prepare(`
    INSERT INTO journal_entries
      (entry_id, date_iso, symbol, underlying, action, strategy, notes, thesis, exit_reason, lessons, rating, tags, mistakes,
       source, objective, market_iv_rank, market_support, market_resistance, legs_at_save)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      date_iso=excluded.date_iso,
      symbol=excluded.symbol,
      underlying=excluded.underlying,
      action=excluded.action,
      strategy=excluded.strategy,
      notes=excluded.notes,
      thesis=excluded.thesis,
      exit_reason=excluded.exit_reason,
      lessons=excluded.lessons,
      rating=excluded.rating,
      tags=excluded.tags,
      mistakes=excluded.mistakes,
      source=excluded.source,
      objective=excluded.objective,
      market_iv_rank=excluded.market_iv_rank,
      market_support=excluded.market_support,
      market_resistance=excluded.market_resistance,
      legs_at_save=excluded.legs_at_save,
      saved_at=datetime('now')
  `).run(
    entryId, dateISO, cleanSymbol, cleanUnderlying, cleanAction,
    cleanStrategy, cleanNotes, cleanThesis, cleanExitReason,
    cleanLessons, safeRating, cleanTags, cleanMistakes,
    cleanSource, cleanObjective, safeIvRank, safeSupport, safeResistance, safeLegsAtSave,
  );

  return [
    'JOURNAL ENTRY SAVED:',
    `- entry_id: ${entryId}`,
    `- date: ${dateISO || 'NULL'}`,
    `- symbol: ${cleanSymbol}`,
    `- action: ${cleanAction || 'NULL'}`,
    `- strategy: ${cleanStrategy || 'NULL'}`,
    `- rating: ${safeRating}`,
    cleanSource === 'auto' ? `- source: auto (technical note)` : null,
  ].filter(Boolean).join('\n');
}

// ── save_note tool: lets the model persist arbitrary knowledge on request
// ("remember this", "add this to your memory") — embeds and indexes it
// immediately via rag.saveNote so it's retrievable by future RAG search in
// this same conversation-turn-independent way trades/journal entries are,
// with no separate storage path or manual re-indexing step required.
async function toolSaveNote({ title, content } = {}) {
  const cleanContent = String(content || '').trim();
  if (!cleanContent) return JSON.stringify({ ok: false, reason: 'content is required — nothing to save.' });
  const cleanTitle = String(title || '').trim() || null;
  try {
    const { refId, embedded } = await rag.saveNote(db, { title: cleanTitle, content: cleanContent }, OLLAMA_HOST, EMBED_MODEL);
    return JSON.stringify({
      ok: true,
      data: { saved: true, refId, title: cleanTitle, embedded, retrievable: embedded ? 'Indexed for semantic search — will surface in future conversations when relevant.' : 'Saved but embedding failed — only retrievable via exact keyword match until re-indexed.' },
    });
  } catch (err) {
    return JSON.stringify({ ok: false, reason: err.message });
  }
}

// ── Correction proposals: flag a wrong stored field WITHOUT writing it ───────
// Deliberately read-only. The model can find plenty of wrong data (see the
// SPCX/"ISHARES 20+ YEAR TREASURY BOND ETF" journal bug) but must never fix it
// unsupervised — that's exactly how that bug got written in the first place.
// This looks up the row's real current value from the DB (never trusts the
// model's own claim of what's currently stored) and returns a proposal for
// the UI to render as an approve/reject card; /api/journal/apply-correction
// is the only thing that actually writes, and only on explicit user approval.
const CORRECTION_FIELDS = ['symbol', 'underlying', 'strategy', 'notes', 'thesis', 'exit_reason', 'lessons', 'tags', 'mistakes', 'objective'];
function proposeCorrection({ entry_id, field, proposed_value, reason }) {
  const cleanField = String(field || '').trim();
  if (!CORRECTION_FIELDS.includes(cleanField)) {
    return { ok: false, error: `field must be one of: ${CORRECTION_FIELDS.join(', ')}` };
  }
  const cleanEntryId = String(entry_id || '').trim();
  if (!cleanEntryId) return { ok: false, error: 'entry_id is required.' };
  const row = db.prepare(`SELECT id, entry_id, ${cleanField} AS current_value FROM journal_entries WHERE entry_id = ?`).get(cleanEntryId);
  if (!row) return { ok: false, error: `No journal_entries row found with entry_id "${cleanEntryId}".` };
  return {
    ok: true,
    id: row.id,
    entry_id: row.entry_id,
    field: cleanField,
    current_value: row.current_value,
    proposed_value: String(proposed_value || '').trim(),
    reason: String(reason || '').trim(),
  };
}

function shouldSuggestJournalDraft(message, reply) {
  const text = `${message || ''}\n${reply || ''}`;
  if (!text.trim()) return false;
  const intent = /\b(trade|position|ticker|underlying|setup|analysis|analy[sz]e|review|prediction|plan|thesis|exit|entry|risk|p&l|profit|loss|journal)\b/i;
  const likelySpecific = /\b[A-Z]{1,5}\b/.test(text);
  return intent.test(text) && likelySpecific;
}

function parseLooseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : raw;
  try { return JSON.parse(candidate); } catch {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  return null;
}

async function generateJournalDraft(message, reply, chatModel) {
  if (!shouldSuggestJournalDraft(message, reply)) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const system = [
      'You create concise trading journal drafts from an analysis conversation.',
      'Return JSON only. No markdown.',
      'If there is not enough trade-specific detail, return {"should_suggest":false}.',
      'If there is enough detail, return:',
      '{"should_suggest":true,"date":"YYYY-MM-DD","symbol":"...","underlying":"...","action":"...","strategy":"...","notes":"...","thesis":"...","exit_reason":"...","lessons":"...","rating":0,"tags":"comma,separated","mistakes":"..."}',
      'Use today as the default date when the date is not explicit.',
      'Prefer the main ticker or contract discussed. Keep notes and lessons brief and concrete.',
    ].join(' ');
    const user = `TODAY: ${today}\n\nUSER MESSAGE:\n${message}\n\nASSISTANT ANALYSIS:\n${reply}`;
    const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const parsed = parseLooseJson(data.message?.content || data.response || '');
    if (!parsed?.should_suggest) return null;
    const symbol = String(parsed.symbol || '').trim().toUpperCase();
    const notes = String(parsed.notes || '').trim();
    const date = normalizeJournalDate(parsed.date) || today;
    if (!symbol || !notes) return null;
    return {
      date,
      symbol,
      underlying: String(parsed.underlying || '').trim().toUpperCase() || '',
      action: String(parsed.action || '').trim(),
      strategy: String(parsed.strategy || '').trim(),
      notes,
      thesis: String(parsed.thesis || '').trim(),
      exit_reason: String(parsed.exit_reason || '').trim(),
      lessons: String(parsed.lessons || '').trim(),
      rating: Number.isFinite(+parsed.rating) ? Math.max(0, Math.min(10, Math.round(+parsed.rating))) : 0,
      tags: String(parsed.tags || '').trim(),
      mistakes: String(parsed.mistakes || '').trim(),
    };
  } catch {
    return null;
  }
}

// Broad net for forward-looking / "what should I do" questions — these get the
// deterministic data → synthesis pipeline instead of a free-form LLM answer.
// Pure history/accounting questions are excluded so they still go through
// query_trades rather than being hijacked into a forward-looking recommendation.
// "Remember this" / "add this to your memory" messages often paste long
// reference content that incidentally contains trigger words for the other
// deterministic short-circuits below (e.g. an options-strategies article
// repeating the word "strategy") — that hijacked the whole reply into an
// unrelated template before the model ever got a chance to call save_note.
// Checked first, and wins over every other intent check in the dispatch.
function isMemoryRequest(message) {
  const m = String(message || '');
  return /\b(add\s+(this|that)\s+to\s+(your\s+)?memory|remember\s+(this|that)|save\s+(this|that)\s+(note|info(?:rmation)?)?|note\s+(this|that)\s+down|keep\s+(this|that)\s+in\s+mind)\b/i.test(m);
}

function isStrategyRequest(message) {
  const m = String(message || '');
  const forwardLooking = /\b(strategy|trade\s+plan|trade\s+idea|what\s+should\s+i\s+trade|setup|give\s+me\s+a\s+trading\s+strategy|recommend\s+(a|some)\s+trade|should\s+i\s+(buy|sell|open|close|enter|exit|hold|roll)|thoughts?\s+on|outlook\s+(for|on)|what\s+do\s+you\s+think\s+(about|of)|bullish\s+or\s+bearish|good\s+(time|entry|play)|play\s+on|next\s+move|what'?s\s+next\s+for|how\s+does\s+.+\s+look|any\s+trades?\s+(on|in|for))\b/i.test(m);
  const historyOnly = /\b(my\s+p&?l|my\s+trades|win\s+rate|wash\s+sale|form\s*8949|tax(es)?|cost\s+basis|last\s+(month|year|week)|how\s+much\s+(did|have)\s+i)\b/i.test(m);
  const performanceReview = /\b(analy[sz]e\s+my\s+performance|performance\s+analysis|scorecard|attribution|hybrid\s+strategic\s+owner|tactical\s+trader|owner\s+vs\s+tactical|strategic\s+owner|trading\s+performance|review\s+my\s+results)\b/i.test(m);
  // "outlook"/"thoughts on" alone is ambiguous between "give me a trade" and
  // "what's the analyst/market read" — pure research phrasing (sentiment,
  // analyst rating/price target, market outlook, news) shouldn't get
  // hijacked into the trade-plan generator and lose the actual answer.
  const researchOnly = /\b(sentiment|analyst\s+(outlook|rating|price\s+target)|price\s+target|market\s+outlook|news|headline|institutional\s+ownership|short\s+interest|insider\s+(buying|selling|trading)|13F)\b/i.test(m);
  return forwardLooking && !historyOnly && !performanceReview && !researchOnly;
}

function isDeepAnalyticsRequest(message) {
  const m = String(message || '');
  return /\b(wash\s*sale|form\s*8949|schedule\s*d|tax\s+estimate(?:s)?|estimated\s+tax(?:es)?|effective\s+tax|effective\s+percentage(?:s)?|irs\s+source|fees?|fee\s+drag|loss\s+analysis|loss\s+cluster|carry\s*forward|project(?:ed|ion)?\s+trend|deep\s+insights|analytics\s+tab)\b/i.test(m);
}

function isShortExposureRequest(message) {
  const m = String(message || '');
  return /\b(how\s+short(?:ed)?|short\s+exposure|net\s+short|am\s+i\s+short|short\s+position|short\s+interest\s+in\s+my\s+account)\b/i.test(m);
}

// Confirmed live, not hypothetical (same reliability-gap pattern as the other
// short-circuits in this file): asked qwen3.8:27b "Any recent insider activity
// or news on AMD from Proactive Scout data?" — it never called get_truth_check,
// answered "no Proactive Scout dataset attached" instead. Rephrased to "What
// does Proactive Scout have on file for AMD? Truth Check verdict please." — it
// still skipped the tool, instead pulled RAG'd trade/journal history for AMD and
// wrote about P&L and win/loss tags, exactly the trade-history/market-data
// conflation the system prompt has an explicit rule against. A ticker-scoped
// Scout lookup is deterministic data already computed and stored — same
// justification as isPortfolioStatusRequest — so it doesn't go through the
// model's tool choice at all.
const SCOUT_LOOKUP_INTENT = /\b(truth\s*check|proactive\s*scout|scout(?:'?s)?\s+(?:data|file|take)|insider\s+(?:buying|selling|trading|activity|transaction)|8-?k|10-?k|10-?q|20-?f|6-?k|form\s*4|sec\s+filing|material\s+event|risk\s+factors?|dilution\s+risk|contradiction(?:s)?)\b/i;
function isScoutLookupRequest(message) {
  const m = String(message || '');
  if (!SCOUT_LOOKUP_INTENT.test(m)) return false;
  return !!detectPrimarySymbol(m);
}

function generateScoutLookupReply({ message }) {
  const symbol = detectPrimarySymbol(message);
  if (!symbol) return null; // isScoutLookupRequest already checked this, but stay defensive
  const result = toolGetTruthCheck(symbol);
  if (!result.ok) {
    return [`Proactive Scout (${symbol})`, `- ${result.reason}`].join('\n');
  }
  const d = result.data;
  const lines = [`Proactive Scout — ${symbol}`];

  if (d.latest_truth_check) {
    const tc = d.latest_truth_check;
    lines.push('', `Truth Check (${(tc.analyzed_at || '').slice(0, 16).replace('T', ' ')}) — model: ${tc.model_used || 'unknown'}`,
      `- Verdict: ${tc.verdict || 'unknown'} (severity: ${tc.severity || 'unknown'}, confidence: ${tc.confidence ?? 'n/a'})`,
      `- ${tc.verdict_reason || tc.summary || 'No summary recorded.'}`);
    if (tc.contradictions?.length) {
      lines.push('- Contradictions:');
      for (const c of tc.contradictions.slice(0, 5)) lines.push(`  - [${c.category || 'other'}] ${c.issue} (${c.citation || 'no citation'})`);
    }
  } else {
    lines.push('', 'Truth Check: not yet run for this ticker.');
  }

  lines.push('', `SEC filings on file (SEC, highest trust):`);
  lines.push(d.sec_filings_on_file?.length
    ? d.sec_filings_on_file.map(f => `- ${f.form_type} filed ${f.filed_at} — ${f.description || 'no description'}`).join('\n')
    : '- None on file.');

  lines.push('', `Recent insider (Form 4) activity (SEC, highest trust):`);
  lines.push(d.recent_insider_activity?.length
    ? d.recent_insider_activity.map(tx => `- ${tx.transaction_date}: ${tx.owner_name || 'Unknown'}${tx.owner_title ? ` (${tx.owner_title})` : ''} — ${tx.transaction_code_label || 'transaction'}, ${tx.acquired_disposed_code === 'A' ? '+' : tx.acquired_disposed_code === 'D' ? '-' : ''}${tx.shares ?? '?'} shares${tx.price_per_share ? ` @ $${tx.price_per_share}` : ''}`).join('\n')
    : '- None on file.');

  lines.push('', `Recent news (API — Finnhub, structured third-party):`);
  lines.push(d.recent_news?.length
    ? d.recent_news.map(n => `- ${(n.published_at || '').slice(0, 10)} [${n.source || 'Finnhub'}] ${n.headline}`).join('\n')
    : '- None on file.');

  lines.push('', `Latest crawled sentiment (WEB — lowest trust, no source guarantee):`);
  lines.push(d.latest_sentiment ? `- ${d.latest_sentiment.excerpt.slice(0, 500)}${d.latest_sentiment.excerpt.length > 500 ? '…' : ''}` : '- None on file.');

  return lines.join('\n');
}

// "How is my portfolio doing today" and its variants get a deterministic template
// instead of a tool-calling/RAG-summarized reply — confirmed in practice this was
// necessary, not precautionary: even with the live account snapshot correctly
// positioned right next to the question (not just buried in the system prompt) and
// an explicit "this is the only source for today" instruction, the configured chat
// model still answered from stale RAG monthly-P&L chunks, misreading them as current
// portfolio value and once fabricating an entirely wrong current date. Same reasoning
// as isStrategyRequest/isShortExposureRequest above — this is a demonstrated
// tool/grounding reliability gap, not a hypothetical one.
function isPortfolioStatusRequest(message) {
  const m = String(message || '');
  return /\b(how\s+is\s+(my\s+|the\s+)?portfolio|portfolio\s+(doing|status)|how\s+am\s+i\s+doing\s+today|how('?s|\s+is)\s+my\s+account\s+(doing|today)|account\s+status|today'?s\s+p&?l|day'?s\s+p&?l|current\s+portfolio\s+(value|status)|net\s+liq(?:uidation)?\s+(value|today))\b/i.test(m);
}

// Deterministic, not model-chosen — same reasoning as the other short-circuits
// in this file: confirmed in practice that even with an explicit "Memory
// Workflow" section instructing the model to call save_note on this exact
// phrasing, it just narrated a summary instead of calling any tool. Since the
// whole point of this feature is "the app reliably remembers when asked," the
// save can't depend on the model's tool-choice reliability.
async function generateMemorySaveReply({ message }) {
  const content = String(message || '').replace(
    /^\s*(add\s+(this|that)\s+to\s+(your\s+)?memory|remember\s+(this|that)|save\s+(this|that)\s+(note|info(?:rmation)?)?|note\s+(this|that)\s+down|keep\s+(this|that)\s+in\s+mind)\s*:?\s*/i,
    ''
  ).trim();
  if (!content) return null; // nothing left after stripping the trigger phrase — fall through to the normal loop

  const title = content.split(/[.!?\n]/)[0].split(/\s+/).slice(0, 8).join(' ').slice(0, 80) || null;
  let result;
  try { result = JSON.parse(await toolSaveNote({ title, content })); }
  catch (err) { return `I couldn't save that note: ${err.message}`; }

  if (!result.ok) return `I couldn't save that note: ${result.reason}`;
  return `Saved${result.data.title ? ` as "${result.data.title}"` : ''}. ${result.data.retrievable}`;
}

// "Win rate on TSLA" / "compute metrics for X" and similar precise-number asks get a
// deterministic template instead of a tool-calling/RAG-summarized reply — confirmed in
// practice, not hypothetical: qwen3-vl:8b computed "50% win rate" on TSLA options from 4
// RAG-retrieved trade records instead of calling compute_metrics; the real figure across
// the actual 127 closed TSLA option trades is 28.3% — nearly 2x off. When explicitly told
// to call the tool, it still exhausted all 5 tool-calling rounds without answering. This
// is the same "sums a partial sample instead of calling compute_metrics" failure already
// documented in this file for smaller models (see plutusTools.js usage notes) — now
// confirmed on a larger, newer model too. A precise numeric metric has one correct
// answer; there's no reason to let any model re-derive it.
function isMetricsRequest(message) {
  const m = String(message || '');
  return /\b(win\s*rate|profit\s*factor|expectancy|sharpe(?:\s*ratio)?|sortino(?:\s*ratio)?|max(?:imum)?\s*draw\s*-?down|fee\s*drag|compute\s*metrics)\b/i.test(m);
}

function generateMetricsReply({ message }) {
  const symbol = detectPrimarySymbol(message);
  const assetType = /\b(stock|share|equity|equities)\b/i.test(message) ? 'EQUITY' : 'OPTION';
  const result = toolComputeMetrics(symbol ? { symbol, asset_type: assetType } : { asset_type: assetType });
  if (!result?.ok) {
    return [
      `Metrics${symbol ? ` (${symbol})` : ''}`,
      `- ${result?.reason || 'No closed trades matched this scope.'}`,
    ].join('\n');
  }
  const met = result.data.metrics;
  return [
    `Metrics — ${symbol || 'Account-wide'} (${assetType})`,
    `- Closed trades: ${met.trade_count}`,
    `- Win rate: ${met.win_rate}%  |  Profit factor: ${met.profit_factor}`,
    `- Expectancy: ${_fmtUSD(met.expectancy)} per trade`,
    `- Avg win: ${_fmtUSD(met.avg_win)}  |  Avg loss: ${_fmtUSD(met.avg_loss)}`,
    `- Realized P&L: ${_fmtUSD(met.realized_pnl)}  |  Fees: ${_fmtUSD(met.total_fees)} (${met.fee_drag_pct}% drag)`,
    `- Max drawdown: ${_fmtUSD(met.max_drawdown)}  |  Avg hold: ${met.avg_hold_days}d  |  Rolls: ${met.roll_count}`,
    `- Sharpe: ${met.sharpe_ratio}  |  Sortino: ${met.sortino_ratio}`,
    `  (${met._caveat_ratios})`,
  ].join('\n');
}

async function generatePortfolioStatusReply() {
  let snapshot;
  try {
    snapshot = await fetchLiveAccountSnapshot();
  } catch (e) {
    return [
      'Portfolio Status',
      `- Live account data is unavailable: ${e.message}`,
      '- Action: re-auth Schwab and refresh live account data.',
    ].join('\n');
  }
  const todayStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const b = snapshot.balances, s = snapshot.summary;
  const dayDir = b && s.totalDayPnl >= 0 ? 'up' : 'down';
  const openDir = s.totalOpenPnl >= 0 ? 'gain' : 'loss';
  return [
    `Portfolio Status — ${todayStr}`,
    `- Net liquidation value: ${_fmtUSD(b.liquidationValue)}`,
    `- Day P&L: ${_fmtUSD(s.totalDayPnl)} (${dayDir} today)`,
    `- Open P&L on current positions: ${_fmtUSD(s.totalOpenPnl)} (unrealized ${openDir})`,
    `- Buying power: ${_fmtUSD(b.buyingPower)} | Cash: ${_fmtUSD(b.cashBalance)}`,
    `- Positions: ${s.positionCount} total`,
  ].join('\n');
}

function isActionableStrategyReply(reply) {
  const r = String(reply || '');
  const hasStructure = /\b(strategy|trade\s*#?\d|setup)\b/i.test(r);
  const hasEntry = /\b(entry|strike|expiry|expiration|bid|ask)\b/i.test(r);
  const hasRisk = /\b(max\s*profit|max\s*loss|break[ -]?even|invalidat|stop)\b/i.test(r);
  return hasStructure && hasEntry && hasRisk;
}

function detectPrimarySymbol(message) {
  const text = String(message || '').toUpperCase();
  const stop = new Set([
    'AI', 'API', 'IRS', 'USD', 'PNL', 'RAG', 'IV', 'EV', 'CPI', 'FED', 'FOMC',
    'GIVE', 'ME', 'A', 'AN', 'THE', 'FOR', 'WITH', 'AND', 'TO', 'FROM', 'PLAN', 'TRADE', 'STRAT', 'STRATEGY',
    'HOW', 'IS', 'ARE', 'MY', 'YOUR', 'WHAT', 'WHATS', 'DO', 'I', 'AM', 'IN', 'ON', 'OF', 'IT',
    'SHORT', 'SHORTED', 'EXPOSURE', 'POSITION', 'POSITIONS', 'NET', 'SHOW', 'TELL',
  ]);
  const matches = [...new Set(text.match(/\b[A-Z]{1,5}\b/g) || [])].filter(m => !stop.has(m));
  if (!matches.length) return null;

  // Prefer symbols that actually exist in the user's trade database.
  const placeholders = matches.map(() => '?').join(',');
  const existing = db.prepare(
    `SELECT DISTINCT COALESCE(underlying, symbol) as t
     FROM trades
     WHERE COALESCE(underlying, symbol) IN (${placeholders})`
  ).all(...matches).map(r => String(r.t || '').toUpperCase());

  for (const m of matches) {
    if (existing.includes(m)) return m;
  }
  for (const m of matches) {
    if (/^[A-Z]{1,5}$/.test(m)) return m;
  }
  return null;
}

async function generateShortExposureReply({ message }) {
  const symbol = detectPrimarySymbol(message);
  if (!symbol) {
    return [
      'Short Exposure',
      '- I could not detect a ticker in your question.',
      '- Action: ask like "how shorted is SPCX" or "net short TSLA".',
    ].join('\n');
  }

  let snapshot;
  try {
    snapshot = await fetchLiveAccountSnapshot();
  } catch (e) {
    return [
      `Short Exposure (${symbol})`,
      `- Live account data is unavailable: ${e.message}`,
      '- Action: re-auth Schwab and refresh live account data.',
    ].join('\n');
  }

  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const rel = positions.filter(p => {
    const sym = String(p.symbol || '').toUpperCase();
    const und = String(p.underlying || '').toUpperCase();
    return sym === symbol || und === symbol;
  });

  const opt = rel.filter(p => p.assetType === 'OPTION');
  const eq = rel.filter(p => /EQUITY|COLLECTIVE_INVESTMENT/i.test(String(p.assetType || '')));

  const shortContracts = opt.reduce((s, p) => s + Number(p.shortQty || 0), 0);
  const longContracts = opt.reduce((s, p) => s + Number(p.longQty || 0), 0);
  const netOptionContracts = longContracts - shortContracts;
  const netShares = eq.reduce((s, p) => s + Number((p.longQty || 0) - (p.shortQty || 0)), 0);

  const shortLegs = opt
    .filter(p => Number(p.shortQty || 0) > 0)
    .sort((a, b) => Number(b.shortQty || 0) - Number(a.shortQty || 0))
    .slice(0, 10)
    .map(p => `  - ${p.symbol} | short ${Number(p.shortQty || 0)} | MV ${_fmtUSD(p.marketValue || 0)} | OpenP&L ${_fmtUSD(p.openPnl || 0)}`);

  const state = shortContracts > longContracts
    ? 'Net short options exposure'
    : shortContracts < longContracts
      ? 'Net long options exposure'
      : 'Flat options exposure';

  return [
    `Short Exposure (${symbol})`,
    `- ${state}`,
    `- Options: short ${shortContracts.toFixed(2)} contract(s), long ${longContracts.toFixed(2)}, net ${netOptionContracts.toFixed(2)}`,
    `- Stock/ETF shares: net ${netShares.toFixed(2)} share(s)`,
    shortLegs.length ? '- Largest short option legs:' : '- Largest short option legs: none',
    ...shortLegs,
  ].join('\n');
}

function _mid(c) {
  const b = Number(c?.bid ?? 0);
  const a = Number(c?.ask ?? 0);
  if (b > 0 && a > 0) return (b + a) / 2;
  return Number(c?.mark ?? c?.last ?? 0);
}

function _fmtUSD(v) { return `$${Number(v || 0).toFixed(2)}`; }

// Schwab endpoints may return volatility as either decimal (0.29) or percent
// points (29). Normalize to percentage points for consistent reporting.
function _normalizeIvPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 1 ? n * 100 : n;
}

function _flattenChain(map, side) {
  const out = [];
  if (!map || typeof map !== 'object') return out;
  for (const [expKey, strikes] of Object.entries(map)) {
    const expiry = String(expKey).split(':')[0];
    for (const [strike, contracts] of Object.entries(strikes || {})) {
      const c = Array.isArray(contracts) ? contracts[0] : contracts;
      if (!c) continue;
      out.push({
        side,
        expiry,
        strike: Number(strike),
        bid: Number(c.bid ?? 0),
        ask: Number(c.ask ?? 0),
        delta: Number(c.delta ?? 0),
        oi: Number(c.openInterest ?? 0),
        vol: Number(c.totalVolume ?? 0),
        mid: _mid(c),
      });
    }
  }
  return out.filter(x => Number.isFinite(x.strike) && x.mid > 0);
}

function _nearestByDelta(rows, target) {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => Math.abs(a.delta - target) - Math.abs(b.delta - target))[0];
}

function _firstExpiry(rows) {
  return rows.map(r => r.expiry).sort()[0] || null;
}

function _expiryToDte(expiry) {
  const t = new Date(expiry + 'T20:00:00Z').getTime();
  if (!Number.isFinite(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
}

function _pickExpiry(rows, minDte = 7, maxDte = 21) {
  const byExpiry = new Map();
  for (const row of rows) {
    const dte = _expiryToDte(row.expiry);
    if (dte == null || dte < minDte || dte > maxDte) continue;
    const bucket = byExpiry.get(row.expiry) || { expiry: row.expiry, dte, oi: 0, mid: 0, spread: 0, count: 0 };
    bucket.oi += row.oi || 0;
    bucket.mid += row.mid || 0;
    bucket.spread += Math.max(0, (row.ask || 0) - (row.bid || 0));
    bucket.count += 1;
    byExpiry.set(row.expiry, bucket);
  }
  const candidates = [...byExpiry.values()].map(x => ({
    ...x,
    avgMid: x.count ? x.mid / x.count : 0,
    avgSpread: x.count ? x.spread / x.count : 0,
    quality: (x.oi / Math.max(x.count, 1)) - (x.count ? x.spread / x.count : 0) * 10,
  })).sort((a, b) => b.quality - a.quality);
  return candidates[0] || null;
}

function _chainLiquidityScore(rows) {
  if (!rows.length) return 0;
  const oi = rows.reduce((s, r) => s + (r.oi || 0), 0);
  const spreadPct = rows.reduce((s, r) => {
    const mid = r.mid || 0;
    const spr = Math.max(0, (r.ask || 0) - (r.bid || 0));
    return s + (mid > 0 ? spr / mid : 1);
  }, 0) / rows.length;
  return oi / rows.length - spreadPct * 100;
}

// Standard ADX/+DI/-DI read (Wilder's original formula, confirmed against the
// technicalindicators package source): ADX < 20 means the trend is too weak/
// choppy to trust a direction from, regardless of which DI is on top. This
// replaces a cruder 5-day-vs-20-day average % difference, which had no
// standard meaning and no trend-strength gate — it would happily call a
// directionless chop "bullish" or "bearish" off tiny average differences.
function _trendDirection(candles) {
  const adx = indicators.computeADX(candles, 14);
  if (adx) {
    if (adx.adx < 20) return 'neutral';
    return adx.pdi > adx.mdi ? 'bullish' : 'bearish';
  }
  // Not enough bars for ADX (needs ~28+) — fall back to the simple average
  // comparison rather than returning nothing for short histories.
  if (!candles || candles.length < 5) return 'neutral';
  const closes = candles.map(c => Number(c.close || 0)).filter(Boolean);
  if (closes.length < 5) return 'neutral';
  const recent = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const longer = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
  const change = ((recent - longer) / longer) * 100;
  if (change > 1.5) return 'bullish';
  if (change < -1.5) return 'bearish';
  return 'neutral';
}

function _supportResistance(candles, spot) {
  if (!candles?.length || !Number.isFinite(spot) || spot <= 0) return { support: null, resistance: null };
  const highs = candles.map(c => Number(c.high || 0)).filter(Boolean);
  const lows  = candles.map(c => Number(c.low  || 0)).filter(Boolean);
  if (!highs.length || !lows.length) return { support: null, resistance: null };
  const resistanceCandidates = highs.filter(h => h > spot);
  const supportCandidates    = lows.filter(l => l < spot);
  // Nearest ceiling above spot / nearest floor below spot. If spot is making a
  // new high/low over the window there's no such level — report null rather
  // than a same-side value mislabeled as the opposite side.
  const resistance = resistanceCandidates.length ? Math.min(...resistanceCandidates) : null;
  const support     = supportCandidates.length    ? Math.max(...supportCandidates)    : null;
  return { support, resistance };
}

// Rolling realized-vol series (annualized %) — Schwab's API doesn't expose a
// historical implied-vol time series, so this stands in as the regime we rank
// current IV against. Always labeled as a proxy wherever it's surfaced.
//
// Uses the Garman-Klass estimator (full OHLC) rather than plain close-to-close
// log returns: it's a well-established, more statistically efficient realized-
// vol estimator for the same daily bars, since it uses the full high/low/open/
// close range each day instead of throwing away three of those four numbers.
// Formula: 0.5*ln(H/L)^2 - (2ln2-1)*ln(C/O)^2, averaged over the window.
function _realizedVolSeries(candles, window = 20) {
  const bars = (candles || []).filter(c => c.high > 0 && c.low > 0 && c.open > 0 && c.close > 0);
  if (bars.length < window) return [];
  const LN2_TERM = 2 * Math.log(2) - 1;
  const gkVar = bars.map(c => {
    const hl = Math.log(c.high / c.low);
    const co = Math.log(c.close / c.open);
    return 0.5 * hl * hl - LN2_TERM * co * co;
  });
  const series = [];
  for (let i = window - 1; i < gkVar.length; i++) {
    const slice = gkVar.slice(i - window + 1, i + 1);
    const meanVar = slice.reduce((a, b) => a + b, 0) / slice.length;
    const dailyVar = Math.max(meanVar, 0); // guard a rare negative smoothed variance on quiet/gappy bars
    series.push(Math.sqrt(dailyVar * 252) * 100);
  }
  return series;
}

function _ivRankProxy(currentIvPct, candles) {
  const series = _realizedVolSeries(candles);
  if (!series.length || !Number.isFinite(currentIvPct) || currentIvPct <= 0) return null;
  const min = Math.min(...series), max = Math.max(...series);
  if (max <= min) return null;
  const rank = ((currentIvPct - min) / (max - min)) * 100;
  return { rank: Math.max(0, Math.min(100, Math.round(rank))), rvMin: min, rvMax: max };
}

async function generateActionableStrategyFallback({ message }) {
  try {
    const hint = detectPrimarySymbol(message);
    const topTicker = db.prepare(`
      SELECT COALESCE(underlying, symbol) as t, SUM(amount) as pnl
      FROM trades WHERE asset_type='OPTION'
      GROUP BY t ORDER BY pnl DESC LIMIT 1
    `).get()?.t;
    const symbol = (hint || topTicker || 'SPY').toUpperCase();

    let snapshot = { balances: { buyingPower: 0 } };
    try { snapshot = await fetchLiveAccountSnapshot(); } catch {}

    const [qData, hData, cData] = await Promise.all([
      schwabMarket('/quotes', { symbols: symbol, fields: 'quote,fundamental' }),
      schwabMarket('/pricehistory', { symbol, periodType: 'month', period: 3, frequencyType: 'daily', frequency: 1, needExtendedHoursData: false }),
      schwabMarket('/chains', { symbol, contractType: 'ALL', strikeCount: '10', includeUnderlyingQuote: 'true' }),
    ]);

    let spot = Number(qData?.[symbol]?.quote?.lastPrice ?? qData?.[symbol]?.quote?.mark ?? 0);
    if (!Number.isFinite(spot) || spot <= 0) {
      const prior = db.prepare("SELECT COALESCE(AVG(price),0) as p FROM trades WHERE underlying=? OR symbol=?").get(symbol, symbol)?.p;
      spot = Number(prior || 0);
    }
    if (!Number.isFinite(spot) || spot <= 0) {
      return [
        `Market Read (${symbol})`,
        `- Data quality: missing reliable live quote for ${symbol}.`,
        '',
        `No Trade`,
        `- Reason: cannot compute risk/reward without a valid spot price.`,
        `- Action: retry when live quote data is available.`,
        `- Risk Budget: Preserve capital; do not force a trade.`,
      ].join('\n');
    }

    const candles = Array.isArray(hData?.candles) ? hData.candles.slice(-60) : [];
    const trendRet = candles.length >= 2 ? ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100 : 0;
    const trend = _trendDirection(candles);
    const { support, resistance } = _supportResistance(candles, spot);
    const currentIvPct = _normalizeIvPct(cData?.volatility);
    const ivRankInfo = _ivRankProxy(currentIvPct, candles);

    const calls = _flattenChain(cData?.callExpDateMap, 'CALL');
    const puts = _flattenChain(cData?.putExpDateMap, 'PUT');
    const chainRows = [...calls, ...puts];
    const liquidityScore = _chainLiquidityScore(chainRows);
    const expiryPick = _pickExpiry(chainRows, 7, 21) || _pickExpiry(chainRows, 3, 45);
    const expiry = expiryPick?.expiry || _firstExpiry(chainRows) || new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const eCalls = calls.filter(c => c.expiry === expiry);
    const ePuts = puts.filter(p => p.expiry === expiry);

    if (liquidityScore < 10 && !chainRows.length) {
      return [
        `Market Read (${symbol})`,
        `- Spot: ${_fmtUSD(spot)} | Nearest expiry used: ${expiry}`,
        `- Support: ${support != null ? _fmtUSD(support) : '?'} | Resistance: ${resistance != null ? _fmtUSD(resistance) : '?'}`,
        `- IV (chain): ${currentIvPct != null ? currentIvPct.toFixed(1) + '%' : '?'} | IV Rank (proxy vs realized-vol range): ${ivRankInfo ? ivRankInfo.rank + '/100' : 'N/A — insufficient history'}`,
        `- Data quality: insufficient chain liquidity for a high-confidence setup.`,
        '',
        `No Trade`,
        `- Reason: options chain is too thin or unreliable to price a defined-risk entry accurately.`,
        `- Action: Wait for a tighter chain or a cleaner post-event setup.`,
        `- Risk Budget: Preserve capital; do not force a trade.`,
      ].join('\n');
    }

    const shortPut = _nearestByDelta(ePuts.filter(p => p.strike < spot), -0.25) || _nearestByDelta(ePuts, -0.25);
    if (!shortPut) {
      return [
        `Market Read (${symbol})`,
        `- Spot: ${_fmtUSD(spot)} | Nearest expiry used: ${expiry}`,
        `- Data quality: no suitable put strike found from the live chain.`,
        '',
        `No Trade`,
        `- Reason: missing live put quotes at usable deltas for a defined-risk setup.`,
        `- Action: wait for better chain coverage or choose a different expiry.`,
        `- Risk Budget: Preserve capital; do not force a trade.`,
      ].join('\n');
    }

    const longPut = [...ePuts]
      .filter(p => p.strike < shortPut.strike)
      .sort((a, b) => b.strike - a.strike)[0];
    if (!longPut) {
      return [
        `Market Read (${symbol})`,
        `- Spot: ${_fmtUSD(spot)} | Nearest expiry used: ${expiry}`,
        `- Data quality: no protective long put available below short strike ${shortPut.strike}.`,
        '',
        `No Trade`,
        `- Reason: cannot structure a live-data-defined-risk put spread.`,
        `- Action: wait for deeper strike availability or different expiry.`,
        `- Risk Budget: Preserve capital; do not force a trade.`,
      ].join('\n');
    }

    const shortCall = _nearestByDelta(eCalls.filter(c => c.strike > spot), 0.20) || _nearestByDelta(eCalls, 0.20);
    if (!shortCall) {
      return [
        `Market Read (${symbol})`,
        `- Spot: ${_fmtUSD(spot)} | Nearest expiry used: ${expiry}`,
        `- Data quality: no suitable call strike found from the live chain.`,
        '',
        `No Trade`,
        `- Reason: missing live call quotes at usable deltas for a defined-risk setup.`,
        `- Action: wait for better chain coverage or choose a different expiry.`,
        `- Risk Budget: Preserve capital; do not force a trade.`,
      ].join('\n');
    }

    const longCall = [...eCalls]
      .filter(c => c.strike > shortCall.strike)
      .sort((a, b) => a.strike - b.strike)[0];
    if (!longCall) {
      return [
        `Market Read (${symbol})`,
        `- Spot: ${_fmtUSD(spot)} | Nearest expiry used: ${expiry}`,
        `- Data quality: no protective long call available above short strike ${shortCall.strike}.`,
        '',
        `No Trade`,
        `- Reason: cannot structure a live-data-defined-risk call spread.`,
        `- Action: wait for deeper strike availability or different expiry.`,
        `- Risk Budget: Preserve capital; do not force a trade.`,
      ].join('\n');
    }

    const putCredit = Math.max(0, shortPut.mid - longPut.mid);
    const putWidth = Math.max(0, shortPut.strike - longPut.strike);
    const putMaxLoss = Math.max(0, putWidth - putCredit);
    const putBreakeven = shortPut.strike - putCredit;

    const callCredit = Math.max(0, shortCall.mid - longCall.mid);
    const callWidth = Math.max(0, longCall.strike - shortCall.strike);
    const condorCredit = putCredit + callCredit;
    const condorMaxLoss = Math.max(0, Math.max(putWidth, callWidth) - condorCredit);
    const condorBeLow = shortPut.strike - condorCredit;
    const condorBeHigh = shortCall.strike + condorCredit;
    const condorInvalid = trend === 'bearish' ? shortCall.strike : shortPut.strike;

    const bull = trend === 'bullish' ? 50 : trend === 'bearish' ? 25 : 35;
    const bear = trend === 'bearish' ? 45 : trend === 'bullish' ? 20 : 30;
    const base = 100 - bull - bear;

    const bp = Number(snapshot?.balances?.buyingPower || 0);
    const riskPct = bp > 0 ? '2%-4%' : 'small size only';
    const spreadPctPut = shortPut.mid > 0 ? Math.max(0, (shortPut.ask - shortPut.bid) / shortPut.mid) : 1;
    const spreadPctCall = shortCall.mid > 0 ? Math.max(0, (shortCall.ask - shortCall.bid) / shortCall.mid) : 1;
    const confidence = Math.max(35, Math.min(92, Math.round(70 + Math.min(10, liquidityScore / 10) - Math.max(spreadPctPut, spreadPctCall) * 20 + (trend === 'bullish' ? 3 : trend === 'bearish' ? -1 : 0))));
    const putOk = spreadPctPut <= 0.35 && shortPut.oi >= 100;
    const callOk = spreadPctCall <= 0.35 && shortCall.oi >= 100;

    const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
    const sharesHeld = positions
      .filter(p => String(p.symbol || '').toUpperCase() === symbol && /EQUITY|COLLECTIVE_INVESTMENT/i.test(String(p.assetType || '')))
      .reduce((s, p) => s + Number((p.longQty || 0) - (p.shortQty || 0)), 0);
    const coveredCallContracts = Math.max(0, Math.floor(sharesHeld / 100));

    const cashAvail = Number(snapshot?.balances?.cashBalance || snapshot?.balances?.buyingPower || 0);
    const cspPut = _nearestByDelta(ePuts.filter(p => p.strike < spot), -0.20) || shortPut;
    const cspContracts = cspPut?.strike > 0 ? Math.max(0, Math.floor(cashAvail / (cspPut.strike * 100))) : 0;
    const ccCall = _nearestByDelta(eCalls.filter(c => c.strike > spot), 0.20) || shortCall;

    const primary = trend === 'bearish'
      ? `- Primary bias: bearish / range-bound, so favor a call credit spread or iron condor.`
      : trend === 'bullish'
        ? `- Primary bias: bullish / range-bound, so favor a put credit spread or iron condor.`
        : `- Primary bias: neutral, so favor an iron condor only if liquidity is acceptable.`;

    let trade1Strategy;
    let trade1Entry;
    let trade1MaxProfit;
    let trade1MaxLoss;
    let trade1Breakeven;
    let trade1Why;
    let trade1Invalid;

    if (coveredCallContracts > 0 && callOk) {
      trade1Strategy = 'Covered Call';
      trade1Entry = `Sell ${ccCall.strike}C against ${coveredCallContracts * 100} shares, Expiry ${expiry}, Credit ~ ${_fmtUSD(ccCall.mid)}`;
      trade1MaxProfit = (ccCall.strike - spot) + ccCall.mid;
      trade1MaxLoss = Math.max(0, spot - ccCall.mid);
      trade1Breakeven = spot - ccCall.mid;
      trade1Why = 'Monetizes existing shares with premium while defining upside call-away level.';
      trade1Invalid = `Roll or close if trend breaks hard and spot loses support by >2%.`;
    } else if (cspContracts > 0 && putOk) {
      trade1Strategy = 'Cash-Secured Put';
      trade1Entry = `Sell ${cspPut.strike}P, Expiry ${expiry}, Credit ~ ${_fmtUSD(cspPut.mid)} (up to ${Math.max(1, Math.min(cspContracts, 3))} contract${Math.max(1, Math.min(cspContracts, 3)) > 1 ? 's' : ''} within cash constraints)`;
      trade1MaxProfit = cspPut.mid;
      trade1MaxLoss = Math.max(0, cspPut.strike - cspPut.mid);
      trade1Breakeven = cspPut.strike - cspPut.mid;
      trade1Why = 'Premium-selling entry with cash collateral and lower assignment stress.';
      trade1Invalid = `Close if spot closes below ${_fmtUSD(cspPut.strike)} with rising downside momentum.`;
    } else {
      trade1Strategy = trend === 'bearish' ? 'Bear Call Credit Spread' : 'Bull Put Credit Spread';
      trade1Entry = trend === 'bearish'
        ? `Sell ${shortCall.strike}C / Buy ${longCall.strike}C, Expiry ${expiry}, Net Credit ~ ${_fmtUSD(callCredit)}`
        : `Sell ${shortPut.strike}P / Buy ${longPut.strike}P, Expiry ${expiry}, Net Credit ~ ${_fmtUSD(putCredit)}`;
      trade1MaxProfit = trend === 'bearish' ? callCredit : putCredit;
      trade1MaxLoss = trend === 'bearish' ? Math.max(0, callWidth - callCredit) : Math.max(0, putWidth - putCredit);
      trade1Breakeven = trend === 'bearish' ? shortCall.strike + callCredit : shortPut.strike - putCredit;
      trade1Why = 'Defined-risk premium sale that fits your style and current trend.';
      trade1Invalid = `Close if spot breaks ${_fmtUSD(condorInvalid)} with momentum.`;
    }

    return [
      `Market Read (${symbol})`,
      `- Spot: ${_fmtUSD(spot)} | Nearest expiry used: ${expiry}`,
      `- 3M trend: ${trendRet >= 0 ? '+' : ''}${trendRet.toFixed(2)}%`,
      `- Support: ${support != null ? _fmtUSD(support) : '?'} | Resistance: ${resistance != null ? _fmtUSD(resistance) : '?'}`,
      `- IV (chain): ${currentIvPct != null ? currentIvPct.toFixed(1) + '%' : '?'} | IV Rank (proxy vs realized-vol range): ${ivRankInfo ? ivRankInfo.rank + '/100' : 'N/A — insufficient history'}`,
      primary,
      `- Liquidity score: ${liquidityScore.toFixed(1)} | Call spread %: ${(spreadPctCall * 100).toFixed(1)}% | Put spread %: ${(spreadPctPut * 100).toFixed(1)}%`,
      '',
      `Scenario Probabilities: Bull ${bull}%, Base ${base}%, Bear ${bear}% (sum=100%)`,
      `Confidence Score: ${confidence}/100`,
      '',
      `Trade #1`,
      `- Strategy: ${trade1Strategy} (${symbol})`,
      `- Entry: ${trade1Entry}`,
      `- Max Profit: ${_fmtUSD(trade1MaxProfit)} per spread`,
      `- Max Loss: ${_fmtUSD(trade1MaxLoss)} per spread`,
      `- Break-even: ${_fmtUSD(trade1Breakeven)}`,
      `- Why: ${trade1Why}`,
      `- Invalidation: ${trade1Invalid}`,
      '',
      `Trade #2`,
      `- Strategy: Iron Condor (${symbol})`,
      `- Entry: Sell ${shortPut.strike}P / Buy ${longPut.strike}P and Sell ${shortCall.strike}C / Buy ${longCall.strike}C, Expiry ${expiry}, Net Credit ~ ${_fmtUSD(condorCredit)}`,
      `- Max Profit: ${_fmtUSD(condorCredit)} per condor`,
      `- Max Loss: ${_fmtUSD(condorMaxLoss)} per condor`,
      `- Break-even: ${_fmtUSD(condorBeLow)} to ${_fmtUSD(condorBeHigh)}`,
      `- Why: Theta capture in the base case if chain quality is acceptable and the underlying is range-bound.`,
      `- Invalidation: Exit/adjust if price breaches either short strike with momentum.`,
      '',
      `Risk Budget: Target ${riskPct} of buying power per idea; avoid stacking correlated short gamma near key events.`,
      `Key levels: a decisive close beyond support ${support != null ? _fmtUSD(support) : '?'} or resistance ${resistance != null ? _fmtUSD(resistance) : '?'} invalidates the range-bound thesis above.`,
      putOk && callOk ? `Execution note: spreads appear tradable, but still use midpoint or better.` : `Execution note: spreads are wide enough that a real trader would size down or pass.`,
    ].join('\n');
  } catch {
    return null;
  }
}

async function toolGetAccountSnapshot(optionsOnly = false, top = 20) {
  try {
    const snap = await fetchLiveAccountSnapshot();
    const rows = optionsOnly
      ? snap.positions.filter(p => p.assetType === 'OPTION')
      : snap.positions;
    const sorted = [...rows].sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue)).slice(0, Math.max(1, Math.min(50, top)));
    const lines = [
      'LIVE ACCOUNT SNAPSHOT:',
      `- Account: ${snap.accountNumber}`,
      `- Timestamp: ${snap.timestamp}`,
      `- Liquidation Value: $${snap.balances.liquidationValue.toFixed(2)}`,
      `- Buying Power: $${snap.balances.buyingPower.toFixed(2)}`,
      `- Cash Balance: $${snap.balances.cashBalance.toFixed(2)}`,
      `- Day P&L: $${snap.summary.totalDayPnl.toFixed(2)} | Open P&L: $${snap.summary.totalOpenPnl.toFixed(2)}`,
      `- Positions: ${rows.length}${optionsOnly ? ' (options only)' : ''}`,
      '',
      'TOP POSITIONS BY ABS(MARKET VALUE):',
    ];

    for (const p of sorted) {
      const qty = (p.longQty || 0) - (p.shortQty || 0);
      lines.push(
        `${p.symbol} | ${p.assetType}${p.putCall ? ' ' + p.putCall : ''} | Qty ${qty} | MV $${p.marketValue.toFixed(2)} | OpenP&L $${p.openPnl.toFixed(2)} | DayP&L $${p.dayPnl.toFixed(2)}`
      );
    }
    return lines.join('\n');
  } catch (e) {
    return `Error fetching live account snapshot: ${e.message}`;
  }
}

function toolGetAdvancedAnalytics({
  from_date,
  to_date,
  ticker,
  fed_st_rate,
  fed_lt_rate,
  state_rate,
  projection_months,
} = {}) {
  try {
    const data = computeAdvancedAnalytics({
      fromDate: from_date || null,
      toDate: to_date || null,
      ticker: ticker || null,
      federalRateST: Number.isFinite(+fed_st_rate) ? +fed_st_rate : 0.32,
      federalRateLT: Number.isFinite(+fed_lt_rate) ? +fed_lt_rate : 0.15,
      stateRate: Number.isFinite(+state_rate) ? +state_rate : 0.05,
      projectionMonths: Number.isFinite(+projection_months) ? +projection_months : 6,
    });

    const s = data.summary;
    const topLoss = data.losses.topTrades.slice(0, 8)
      .map(r => `${r.underlying || '?'} | ${r.symbol} | ${r.date_sold} | P&L $${r.net_pnl.toFixed(2)} | WS Adj $${r.ws_adjustment.toFixed(2)}`)
      .join('\n');

    const pnlSpec = {
      type: 'line',
      title: 'Monthly Net P&L With Projection',
      labels: [...data.trends.pnlProjection.labels, ...data.trends.pnlProjection.projectedLabels],
      datasets: [
        { label: 'Actual', data: [...data.trends.pnlProjection.values, ...Array(data.trends.pnlProjection.projectedLabels.length).fill(null)] },
        {
          label: 'Projected',
          data: [
            ...Array(Math.max(0, data.trends.pnlProjection.values.length - 1)).fill(null),
            data.trends.pnlProjection.values[data.trends.pnlProjection.values.length - 1] ?? null,
            ...data.trends.pnlProjection.projectedValues,
          ],
        },
      ],
      prefix: '$',
    };

    const washSpec = {
      type: 'bar',
      title: 'Wash Sale Disallowed By Underlying',
      labels: data.washSales.byUnderlying.map(r => r.underlying),
      data: data.washSales.byUnderlying.map(r => Number(r.disallowed || 0)),
      prefix: '$',
    };

    return [
      'ADVANCED ANALYTICS:',
      `- Realized Net: $${s.realizedNet.toFixed(2)} | ST $${s.shortNet.toFixed(2)} | LT $${s.longNet.toFixed(2)}`,
      `- Wash Disallowed: $${s.washDisallowed.toFixed(2)} across ${data.washSales.tradesFlagged} flagged trade(s)`,
      `- Fees: total $${s.totalFees.toFixed(2)} (options $${s.optionFees.toFixed(2)}, equity $${s.equityFees.toFixed(2)})`,
      `- Estimated Tax: federal $${s.estFederal.toFixed(2)} (${(s.effectiveFederalTaxRate * 100).toFixed(1)}% effective) + state $${s.estState.toFixed(2)} (${(s.effectiveStateTaxRate * 100).toFixed(1)}% effective) = $${s.estTotal.toFixed(2)} (${(s.effectiveTaxRate * 100).toFixed(1)}% effective), quarterly $${s.quarterly.toFixed(2)}`,
      `- Estimated Net P&L After Fees And Taxes: $${s.estNetAfterFeesAndTaxes.toFixed(2)} (${(s.retentionRateAfterTax * 100).toFixed(1)}% kept)`,
      `- Loss Carryforward Estimate: $${s.estCarryforwardLoss.toFixed(2)}`,
      `- IRS Source: ${data.meta?.irsSource?.title || 'IRS FAQ'} | ${data.meta?.irsSource?.url || ''}`,
      '',
      'TOP LOSSES:',
      topLoss || 'None',
      '',
      'Use these chart blocks directly in response:',
      `\`\`\`chart\n${JSON.stringify(pnlSpec)}\n\`\`\``,
      `\`\`\`chart\n${JSON.stringify(washSpec)}\n\`\`\``,
    ].join('\n');
  } catch (e) {
    return `Error computing advanced analytics: ${e.message}`;
  }
}

function generateDeepAnalyticsReply({ message }) {
  const ticker = detectPrimarySymbol(message) || undefined;
  return toolGetAdvancedAnalytics({ ticker });
}

// ── Structured compute tools (plutusTools.js) — thin wrappers that just
//    forward to the pure (db, args) -> {ok, data|reason} functions ─────────
function toolGetTrades(args)      { return plutusTools.getTrades(db, args || {}); }
function toolGetPositions(args)   { return plutusTools.getPositions(db, args || {}); }
function toolComputeMetrics(args) { return plutusTools.computeMetrics(db, args || {}); }

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Reuses the existing (whole-account, unfiltered) tradingInsights functions for
// setup/day-of-week/hold-time leaks — those don't yet accept symbol/date filters,
// so this tool's symbol/date_from/date_to only narrow the wash_sale_drag leak
// (via computeAdvancedAnalytics, which does accept them). Flagged rather than
// silently ignored.
function toolGenerateLeakInsights({ symbol, date_from, date_to, min_confidence, max_insights, leak_types } = {}) {
  try {
    const minConf = Number.isFinite(+min_confidence) ? +min_confidence : 0;
    const maxN = Math.max(1, Math.min(50, Number(max_insights) || 10));
    const wantedTypes = Array.isArray(leak_types) && leak_types.length ? new Set(leak_types) : null;

    const insights = [];
    let idSeq = 1;

    for (const s of tradingInsights.computeWinRateBySetup(db).filter(s => s.totalPnl < 0 && s.trades >= 5)) {
      insights.push({
        insight_id: `leak_${idSeq++}`, leak_type: 'underperforming_setup',
        estimated_pnl_impact: +s.totalPnl.toFixed(2),
        confidence: +Math.min(1, s.trades / 15).toFixed(2),
        description: `"${s.setup}" is a net loser — ${s.trades} trades, ${s.winRate.toFixed(0)}% win rate, $${s.totalPnl.toFixed(2)} net.`,
        strategy: s.setup,
        evidence: { trade_count: s.trades, win_rate: +s.winRate.toFixed(1), avg_pnl: +s.avgPnl.toFixed(2) },
        recommendation: `Reduce size or pause "${s.setup}" until the win rate improves, or review entry criteria for this setup.`,
      });
    }

    const byDOW = db.prepare(`SELECT strftime('%w', date_iso) as dow, SUM(amount) as pnl, COUNT(*) as n FROM trades WHERE asset_type='OPTION' GROUP BY dow`).all();
    const worstDay = byDOW.filter(d => d.n >= 5).sort((a, b) => a.pnl - b.pnl)[0];
    if (worstDay && worstDay.pnl < 0) {
      insights.push({
        insight_id: `leak_${idSeq++}`, leak_type: 'day_of_week_drag',
        estimated_pnl_impact: +worstDay.pnl.toFixed(2),
        confidence: +Math.min(1, worstDay.n / 15).toFixed(2),
        description: `Trading on ${DOW_NAMES[Number(worstDay.dow)]} has been a net loser (-$${Math.abs(worstDay.pnl).toFixed(2)} over ${worstDay.n} trades).`,
        evidence: { day_of_week: DOW_NAMES[Number(worstDay.dow)], trade_count: worstDay.n },
        recommendation: `Review what's different about ${DOW_NAMES[Number(worstDay.dow)]} entries — consider sizing down or skipping that day.`,
      });
    }

    const byHolding = tradingInsights.computeHoldingPeriodBreakdown(db);
    const sameDay = byHolding.find(b => b.bucket === 'Same day');
    const longHold = byHolding.find(b => b.bucket === '30+ days');
    if (sameDay?.count >= 5 && longHold?.count >= 5 && longHold.winRate < sameDay.winRate - 15) {
      insights.push({
        insight_id: `leak_${idSeq++}`, leak_type: 'hold_time_effect',
        estimated_pnl_impact: +longHold.pnl.toFixed(2),
        confidence: +Math.min(1, (sameDay.count + longHold.count) / 20).toFixed(2),
        description: `Positions held 30+ days win ${longHold.winRate.toFixed(0)}% of the time vs. ${sameDay.winRate.toFixed(0)}% for same-day exits — worth checking whether losers are being held too long.`,
        evidence: { same_day_win_rate: +sameDay.winRate.toFixed(1), long_hold_win_rate: +longHold.winRate.toFixed(1), long_hold_pnl: longHold.pnl },
        recommendation: `Tighten exit rules for positions approaching 30 days — cutting losers earlier likely improves this bucket's win rate.`,
      });
    }

    const feeRow = db.prepare(`SELECT SUM(fees) as fees, SUM(amount) as pnl FROM trades WHERE asset_type='OPTION'`).get();
    if (feeRow.pnl && feeRow.fees) {
      const feeDragPct = feeRow.pnl !== 0 ? Math.abs(feeRow.fees / feeRow.pnl) * 100 : 0;
      if (feeDragPct >= 3) {
        insights.push({
          insight_id: `leak_${idSeq++}`, leak_type: 'fee_drag',
          estimated_pnl_impact: -Math.abs(feeRow.fees),
          confidence: 1,
          description: `Commissions/fees total $${feeRow.fees.toFixed(2)}, about ${feeDragPct.toFixed(1)}% of gross options P&L.`,
          evidence: { total_fees: +feeRow.fees.toFixed(2), fee_drag_pct: +feeDragPct.toFixed(1) },
          recommendation: `Fee drag is elevated — consolidating small/frequent contracts into fewer, larger positions would reduce per-leg commission cost.`,
        });
      }
    }

    try {
      const adv = computeAdvancedAnalytics({ fromDate: date_from || null, toDate: date_to || null, ticker: symbol || null });
      if (adv?.summary?.washDisallowed > 0) {
        insights.push({
          insight_id: `leak_${idSeq++}`, leak_type: 'wash_sale_drag',
          estimated_pnl_impact: -Math.abs(adv.summary.washDisallowed),
          confidence: 1,
          description: `$${adv.summary.washDisallowed.toFixed(2)} in losses across ${adv.washSales.tradesFlagged} trade(s) are wash-sale disallowed — the loss deduction is deferred, not lost, but it delays the tax benefit.`,
          evidence: { disallowed_amount: +adv.summary.washDisallowed.toFixed(2), trades_flagged: adv.washSales.tradesFlagged },
          recommendation: `Use get_advanced_analytics for the full flagged-trade list; consider a >30-day gap before re-entering a symbol you just closed at a loss.`,
        });
      }
    } catch {}

    let filtered = wantedTypes ? insights.filter(i => wantedTypes.has(i.leak_type)) : insights;
    filtered = filtered.filter(i => i.confidence >= minConf);
    filtered.sort((a, b) => a.estimated_pnl_impact - b.estimated_pnl_impact);
    filtered = filtered.slice(0, maxN);

    const totalEstimatedLeak = +filtered.reduce((s, i) => s + Math.min(0, i.estimated_pnl_impact), 0).toFixed(2);
    return {
      ok: true,
      data: { insights: filtered, summary: { total_estimated_leak: totalEstimatedLeak, insight_count: filtered.length, top_leak_type: filtered[0]?.leak_type || null } },
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Auto-journaling: self-documenting audit trail ─────────────────────────────
// Builds market conditions (support/resistance, IV-rank proxy) as of a given
// date. Schwab's API has no historical implied-vol time series, so entries
// opened in the past get a realized-vol-based proxy computed from price
// history as of that date (real data, honestly labeled as a proxy); entries
// opened within the last 3 days additionally get a live options-chain IV
// snapshot, since it's still close enough to entry to be representative.
async function buildTechnicalMarketContext(ticker, asOfISO) {
  const asOfMs = asOfISO ? new Date(asOfISO + 'T20:00:00Z').getTime() : Date.now();
  const daysSinceOpen = Math.round((Date.now() - asOfMs) / 86400000);

  const hData = await schwabMarket('/pricehistory', {
    symbol: ticker, periodType: 'year', period: 1, frequencyType: 'daily', frequency: 1, needExtendedHoursData: false,
  });
  const allCandles = Array.isArray(hData?.candles) ? hData.candles : [];
  const asOfCandles = allCandles.filter(c => c.datetime <= asOfMs).slice(-90);
  const spot = asOfCandles.length ? Number(asOfCandles[asOfCandles.length - 1].close || 0) : 0;
  const { support, resistance } = _supportResistance(asOfCandles.slice(-60), spot);

  let ivPct = null;
  let ivBasis = 'unavailable — no historical implied-vol source for this ticker/date';
  if (daysSinceOpen <= 3) {
    try {
      const cData = await schwabMarket('/chains', { symbol: ticker, contractType: 'ALL', strikeCount: '4', includeUnderlyingQuote: 'true' });
      if (cData?.volatility != null) {
        ivPct = _normalizeIvPct(cData.volatility);
        ivBasis = 'live options-chain snapshot (within 3 days of entry)';
      }
    } catch {}
  }
  const ivRankInfo = _ivRankProxy(ivPct, asOfCandles);
  const ivRankBasis = ivRankInfo
    ? `proxy vs trailing realized-vol range (${ivBasis})`
    : (ivPct == null ? ivBasis : 'insufficient price history for a realized-vol range');

  return { spot, support, resistance, ivPct, ivRank: ivRankInfo?.rank ?? null, ivRankBasis };
}

// Deterministic fallback note used when the LLM call fails/times out — the
// audit trail still gets populated even if Ollama is unreachable.
function _deterministicTechnicalNote(pos, ctx) {
  const dir = /Sell to Open/.test(pos.actions) ? 'premium sale' : /Buy to Open/.test(pos.actions) ? 'premium purchase' : 'position';
  const lvl = ctx.support != null && ctx.resistance != null
    ? `between support ${_fmtUSD(ctx.support)} and resistance ${_fmtUSD(ctx.resistance)}`
    : 'with no reliable support/resistance read (insufficient price history)';
  const ivLine = ctx.ivRank != null ? `IV Rank ~${ctx.ivRank}/100 (${ctx.ivRankBasis})` : `IV Rank unavailable (${ctx.ivRankBasis})`;
  return {
    thesis: `Auto-logged ${dir} on ${pos.underlying} ${lvl}. ${ivLine}.`,
    notes: `Contract ${pos.symbol}. Legs: ${pos.actions}. Opened ${pos.opened}${pos.closed && pos.closed !== pos.opened ? `, closed ${pos.closed}` : ''}.`,
    objective: /Sell to Open/.test(pos.actions)
      ? 'Collect theta while price stays outside the short strike into expiry.'
      : 'Directional or volatility exposure targeting a move through the position\'s breakeven before expiry.',
    tags: 'auto-journaled',
  };
}

// Lead-analyst technical note — rationale, market conditions at execution, and
// strategy objective — generated with zero manual input.
async function generateAutoTechnicalNote(pos, ctx, chatModel) {
  try {
    const style = buildTradingStyleProfile();
    const system = [
      'You are a lead trading analyst producing a concise, professional technical note for a self-documenting trade journal.',
      'Return JSON only, no markdown: {"thesis":"...","notes":"...","objective":"...","tags":"comma,separated"}.',
      'Thesis = why this trade fits the market read given. Notes = brief factual recap. Objective = the specific strategy goal (e.g. theta capture, directional breakout, hedge).',
      'Cite the given support/resistance and IV rank explicitly. Do not invent numbers that were not provided. Keep each field under 40 words.',
    ].join(' ');
    const user = [
      `POSITION: ${pos.underlying} contract ${pos.symbol}`,
      `Legs: ${pos.actions} | Opened: ${pos.opened} | Closed: ${pos.closed || 'still open'} | Net P&L so far: $${Number(pos.net_pnl || 0).toFixed(2)}`,
      `MARKET CONDITIONS AT EXECUTION: spot ${_fmtUSD(ctx.spot)}, support ${ctx.support != null ? _fmtUSD(ctx.support) : 'n/a'}, resistance ${ctx.resistance != null ? _fmtUSD(ctx.resistance) : 'n/a'}, IV Rank ${ctx.ivRank != null ? ctx.ivRank + '/100' : 'n/a'} (${ctx.ivRankBasis}).`,
      `TRADER'S HISTORICAL STYLE:\n${style}`,
    ].join('\n');
    const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chatModel, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return _deterministicTechnicalNote(pos, ctx);
    const data = await r.json();
    const parsed = parseLooseJson(data.message?.content || '');
    if (!parsed?.thesis && !parsed?.notes) return _deterministicTechnicalNote(pos, ctx);
    return {
      thesis: String(parsed.thesis || '').trim(),
      notes: String(parsed.notes || '').trim(),
      objective: String(parsed.objective || '').trim(),
      tags: String(parsed.tags || 'auto-journaled').trim(),
    };
  } catch {
    return _deterministicTechnicalNote(pos, ctx);
  }
}

// Auto-journals every OPTION contract that has new legs since its last saved
// note — runs after every Schwab sync with zero manual input, producing a
// self-documenting audit trail (rationale, market conditions at execution,
// strategy objective) for each position.
async function autoJournalNewPositions(chatModel) {
  const positions = db.prepare(`
    SELECT symbol, underlying,
           MIN(date_iso) as opened, MAX(date_iso) as closed,
           SUM(amount) as net_pnl, COUNT(*) as legs,
           GROUP_CONCAT(DISTINCT action) as actions
    FROM trades WHERE asset_type='OPTION'
    GROUP BY symbol
  `).all();

  let journaled = 0;
  for (const pos of positions) {
    if (!pos.underlying || !pos.symbol) continue;
    const existing = db.prepare('SELECT legs_at_save FROM journal_entries WHERE entry_id=?').get(pos.symbol);
    if (existing && Number(existing.legs_at_save) === Number(pos.legs)) continue; // nothing new since last note

    try {
      const ctx = await buildTechnicalMarketContext(pos.underlying, pos.opened);
      const note = await generateAutoTechnicalNote(pos, ctx, chatModel);
      saveJournalEntry({
        entryIdOverride: pos.symbol,
        date: pos.opened,
        symbol: pos.symbol,
        underlying: pos.underlying,
        action: (pos.actions || '').split(',')[0],
        strategy: pos.closed && pos.closed !== pos.opened ? 'Closed Position' : 'Open Position',
        notes: note.notes,
        thesis: note.thesis,
        objective: note.objective,
        tags: note.tags,
        source: 'auto',
        market_iv_rank: ctx.ivRank,
        market_support: ctx.support,
        market_resistance: ctx.resistance,
        legs_at_save: pos.legs,
      });
      journaled++;
    } catch (e) {
      console.warn(`[auto-journal] skipped ${pos.symbol}: ${e.message}`);
    }
  }
  if (journaled) console.log(`📓  Auto-journaled ${journaled} position(s) with technical notes`);
  return journaled;
}

// ── API: Ollama chat with RAG ─────────────────────────────────────────────────
app.post('/api/ai/chat', async (req, res) => {
  const { message, model, history = [] } = req.body;
  let chatModel = model || CHAT_MODEL;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided' });

  // ── 1. Aggregate stats (always included) ──────────────────────────────────
  let statsContext = 'No trade data yet — run a Schwab sync first.';
  let styleContext = 'Trading style profile unavailable.';
  let liveAccountContext = 'Live account snapshot unavailable in this response.';
  try {
    const dash = computeDashboard(null, null);
    if (dash) {
      const s = dash.stats;
      const top = dash.topSymbols.slice(0, 6)
        .map(t => `  ${t.ticker}: $${t.net_pnl.toFixed(0)} (${t.contracts} contracts)`).join('\n');
      statsContext = `
OPTIONS TRADING ACCOUNT SUMMARY (Charles Schwab, live data):
- DB records: ${dash.dbTotal} | Options transactions: ${dash.optionsTotal}
- Closed positions: ${s.totalTrades} (${s.winCount} wins, ${s.lossCount} losses)
- Options Net P&L: $${s.netPnL.toFixed(2)}
- Win rate: ${s.winRate.toFixed(1)}%  |  Profit factor: ${s.profitFactor.toFixed(2)}
- Avg win: $${s.avgGain.toFixed(2)}  |  Avg loss: $${s.avgLoss.toFixed(2)}
- Top tickers by options P&L:
${top}`.trim();
    }
    styleContext = buildTradingStyleProfile();
  } catch {}

  try {
    const snap = await fetchLiveAccountSnapshot();
    const optCount = snap.positions.filter(p => p.assetType === 'OPTION').length;
    liveAccountContext = [
      'LIVE ACCOUNT SNAPSHOT (REAL-TIME):',
      `- Liquidation value: $${snap.balances.liquidationValue.toFixed(2)}`,
      `- Buying power: $${snap.balances.buyingPower.toFixed(2)} | Cash: $${snap.balances.cashBalance.toFixed(2)}`,
      `- Day P&L: $${snap.summary.totalDayPnl.toFixed(2)} | Open P&L: $${snap.summary.totalOpenPnl.toFixed(2)}`,
      `- Positions: ${snap.summary.positionCount} total (${optCount} options)`,
    ].join('\n');
  } catch (e) {
    liveAccountContext = `Live account snapshot unavailable: ${e.message}`;
  }

  // ── 2. RAG retrieval (semantic search over trades + journal) ───────────────
  let ragContext = '';
  let ragResults = [];

  // Detect queries about external market info — skip RAG for these so trade data
  // isn't mistaken for "market news," and pre-fetch real web results instead.
  // "current" and "price" bare (and "latest" bare) used to be triggers here —
  // that misclassified plain account questions ("what's my current PnL",
  // "show me my latest trade") as external market queries, skipping
  // query_trades/tool-calling entirely and routing into a web search that
  // returns nothing useful for an account-specific question — which is what
  // led the model to fabricate fictitious data sources instead. Now these
  // only fire in an unambiguous market-price phrase, and ACCOUNT_INTENT below
  // is an explicit override that wins regardless of what else matches.
  const MARKET_INTENT = /\b(news|headline|market|stock\s+price|share\s+price|current\s+price|market\s+price|spot\s+price|today'?s?\s+(market|news)|what('?s|\s+is)\s+(happening|going\s+on)|latest\s+news|recent\s+news|catalyst|earnings\s+today|analyst|upgrade|downgrade|economic\s+(calendar|data)|fed|fomc|cpi|jobs\s+report|gdp|sentiment|outlook|forecast|guidance|price\s+target|short\s+interest|insider\s+(buying|selling|trading)|13F|institutional\s+ownership)\b/i;
  const ACCOUNT_INTENT = /\bmy\s+(pnl|p\s?&\s?l|position|trade|account|portfolio|win\s?rate|performance|holding|option|stock|equity)/i;
  // A request for actual chain/greeks data (e.g. "give me IV, delta, and volume")
  // needs the real get_options_chain tool, not a web search — "catalyst"/"outlook"
  // etc. in MARKET_INTENT would otherwise route this into web-search-only mode
  // (RAG + tools skipped), same failure mode ACCOUNT_INTENT already guards
  // against, just triggered by options terminology instead of "my ...".
  const OPTIONS_DATA_INTENT = /\b(options?\s+chain|iv\s+rank|implied\s+volatility|delta|gamma|theta|vega|open\s+interest|strike\s*(price)?|greeks?)\b/i;
  const isMarketQuery = MARKET_INTENT.test(message) && !ACCOUNT_INTENT.test(message) && !OPTIONS_DATA_INTENT.test(message);

  let prefetchedNews = '';
  if (isMarketQuery && (PERPLEXITY_API_KEY || OLLAMA_API_KEY)) {
    try {
      prefetchedNews = await webSearch(message) || '';
      console.log('[chat] Market query detected — pre-fetched web results');
    } catch (e) { console.warn('[chat] Pre-fetch error:', e.message); }
  }

  if (!isMarketQuery) {
    try {
      // Always pin summary docs (aggregate data critical for common questions)
      const summaryDocs = db.prepare("SELECT source, ref_id, content, metadata, embedding FROM rag_docs WHERE source='summary'").all();
      const semanticResults = await rag.search(db, message, OLLAMA_HOST, EMBED_MODEL, 8);
      // Merge: summaries first, then semantic hits not already included
      const seenIds = new Set(summaryDocs.map(d => d.source + ':' + d.ref_id));
      const extra = semanticResults.filter(r => !seenIds.has(r.source + ':' + r.ref_id)).slice(0, 4);
      ragResults = [...summaryDocs, ...extra];
      if (ragResults.length) {
        ragContext = '\n\nRELEVANT RECORDS FOR THIS QUERY:\n\n' + rag.buildContext(ragResults);
      }
    } catch (e) { console.warn('RAG search error:', e.message); }
  }

  // ── 3. Build prompt ────────────────────────────────────────────────────────
  const todayStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' EST';
  // Spelled out as plain facts, not left for the model to derive from
  // todayStr — a model's training-time sense of "the current year" can
  // override a bare date string, producing exactly the failure this
  // prevents: calling the actual current year "next year" mid-answer.
  const currentYearNum = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date()));

  const systemPrompt = `You are Plutus, a professional AI trading analyst and personal financial advisor. You specialize in options trading, tax strategy, and portfolio analysis for an active trader using Charles Schwab.

You are advising a hybrid trader with two mandates:
- Primary mandate: Wheel strategy on assets the trader is happy to own long-term, prioritizing dividend quality and durable growth.
- Secondary mandate: tactical day trades and swing trades for short-term gains.
- Your analysis must reflect both mandates explicitly; do not treat this trader as only an options scalper or only a passive investor.

Today is ${todayStr}.
- The CURRENT year is ${currentYearNum}. Last year was ${currentYearNum - 1}. Next year will be ${currentYearNum + 1}. Do not compute this yourself from training-time assumptions or from a date seen elsewhere in this prompt — use these numbers directly. A trade dated ${currentYearNum} is from THIS year, not next year.
- This is the only source of truth for the current date. Trade records, RAG context, and option expiries below will contain OTHER dates (past trades, expirations, etc.) — never let one of those override or blur what "today" is. Before saying anything like "approaching end of [month]" or "this week," re-check it against ${todayStr}, not against the most recent date you happened to read.
- get_quote and get_options_chain results are live/real-time snapshots and carry NO calendar date of their own. Never label them "as of [some date]" using a date pulled from a journal entry, RAG record, or trade history — that is a different, unrelated date. Describe live-data results as "current" or "as of today (${todayStr})" only.
- Never state a specific P&L, win rate, or trade count for a given month/year unless a tool call (query_trades, get_trades, get_positions, compute_metrics) actually returned data for that exact year-month in THIS conversation. If asked about a month/year that hasn't happened yet relative to ${todayStr}, or one you have not queried, say plainly that there is no trade data for it — never infer or estimate a figure from a different period's numbers or from RAG text mentioning that month name.

## Your Personality & Communication Style
- Speak like a seasoned Wall Street analyst — confident, precise, and professional
- Think out loud when appropriate: walk through your reasoning step by step
- Be direct and concise; lead with the answer, then support it with data
- Use proper financial terminology (delta, theta, IV, P&L, cost basis, etc.)
- When the news or market context matters, say so and look it up
- Never be generic — always tie answers back to this trader's actual data when possible

## Portfolio Lens (Required)
- Frame recommendations and post-trade analysis using two books:
  1) Strategic Owner (Wheel + assignment-ready accumulation on long-term dividend/growth assets)
  2) Tactical Trader (day/swing directional and volatility trades)
- For performance reviews, always provide a split view: Strategic vs Tactical, then combined total.
- Include contributions from: realized P&L, fee drag, estimated tax drag, assignment outcomes, and capital efficiency.
- If classification is ambiguous, label it as mixed/unclear and state assumptions clearly.

## Options Mechanics — STRICT
Before stating any options recommendation, verify the payoff direction matches the stated thesis. Get this wrong and the trade loses money — treat it as seriously as a data-fabrication error.
- ITM/OTM is a plain numeric comparison of spot vs. strike — get this wrong and every conclusion built on it is wrong too. For a PUT: strike ABOVE spot = in-the-money (ITM); strike BELOW spot = out-of-the-money (OTM). For a CALL: strike ABOVE spot = OTM; strike BELOW spot = ITM. Before calling any strike "OTM" or "ITM," explicitly state the spot price, the strike, and which one is higher — do not just assert the label. A short put struck ABOVE spot is already ITM and has high/near-certain assignment risk, not low risk — never describe it as a safe, low-assignment-risk income trade.
- A short/sold put (naked or the short leg of a spread) profits when the underlying stays flat or rises, and LOSES as it falls. Never recommend selling a put "because" or "to benefit from" an expected decline — that is backwards.
- A short/sold call profits when the underlying stays flat or falls, and LOSES as it rises. Never recommend selling a call "because" of an expected rally.
- A credit spread (net premium received, e.g. bull put spread, bear call spread) is not the same structure as a debit spread (net premium paid, e.g. bull call spread, bear put spread) — do not use these names interchangeably.
- An iron condor is four legs (a short strangle plus a protective long strangle further out) — never describe a single two-leg spread (e.g. "sell put X, buy put Y") as an iron condor.
- Before finalizing any recommendation, restate in one line: what direction you expect, which structure you're proposing, and confirm that structure actually profits in that direction. If it doesn't line up, fix the recommendation before presenting it.

## Data Rules — STRICT
- **Ticker/instrument identity**: NEVER state what a symbol "is" (company name, ETF, index fund, etc.) from your own general knowledge — many symbols in this account are not real-world tickers you'd recognize from training data, and guessing a plausible-sounding real company/ETF for an unfamiliar symbol is a serious, repeated failure mode. Only use the description field from the trades table (via query_trades) to identify an instrument. If no description is available, do not supply one — just use the raw symbol.
- **SPCX specifically**: this account's SPCX refers to "SPACE EX TECH SPACEX" (per its own trade descriptions) — it is NOT any SPDR S&P index ETF (not S&P 600, not S&P 1500 Composite/SPTM, not any SPDR fund). Do not describe it as an ETF under any circumstance, even if the user's own message asserts otherwise — correct that assertion instead of adopting it.
- **Account history data** (P&L, trades, style metrics): use query_trades. Never fabricate numbers.
- **Current live balances/positions**: use get_account_snapshot when needed.
- **Derived metrics** (win rate, profit factor, drawdown, expectancy, fee drag): use compute_metrics — never sum or average raw get_trades/query_trades rows by hand.
- **Rolled options**: get_positions/compute_metrics already treat a same-day close+reopen (same underlying, same call/put side) as ONE trade with aggregate P&L/hold-time across the whole chain — never re-split a rolled position's legs into separate wins/losses yourself, and never sum a chain's legs by hand even when narrating them individually.
- **Incomplete pricing**: if a position has has_incomplete_pricing: true (or compute_metrics returns a caveat about excluded positions), say so explicitly — that $0/near-$0 P&L is a data gap, not a real breakeven trade.
- **Stale open positions**: if a position has past_expiry_unclosed: true, its expiry date has already passed with no closing trade recorded — say it's very likely expired/closed with the closing record just missing from this data, not that it's live open exposure.
- **Partial tool results**: if get_trades/get_positions returns truncated: true (see the note field), never sum/average that partial list into a total — call compute_metrics, or narrow the filters and ask again.
- **Recurring patterns / "where am I leaking money"**: use generate_leak_insights rather than eyeballing query_trades output for trends.
- If a tool returns "ok": false, say plainly what's missing (e.g. "no closed trades in that date range") — never fill the gap with an estimate presented as fact.
- **Market news, prices, headlines, current events**: ONLY answer from [LIVE WEB RESULTS] provided in the message. If no live results are present, say "I don't have live market data right now" — do NOT invent headlines or present account trading data as market news.
- **NEVER** repackage the trader's own trade history as market news or current events. SPY being the top performer in this account is NOT a market headline.
- If asked about market news and no live web results were fetched, say so and suggest the user check their Perplexity/Ollama API keys.

## Database Schema (use query_trades for all account lookups)
Table: **trades**
| Column      | Type  | Notes |
|-------------|-------|-------|
| id          | int   | row ID |
| date_iso    | text  | YYYY-MM-DD |
| action      | text  | BTO, STO, BTC, STC, BUY, SELL, EXPIRED, ASSIGNED |
| symbol      | text  | option: "PLTR 07/02/2026 113.00 C", equity: "PLTR" |
| underlying  | text  | ticker only, e.g. "PLTR" |
| asset_type  | text  | OPTION or EQUITY |
| quantity    | real  | number of contracts or shares |
| price       | real  | per-share price |
| fees        | real  | commissions |
| amount      | real  | net cash: negative = debit/cost, positive = credit/proceeds |
| description | text  | Schwab description string |

Examples:
- "SELECT * FROM trades WHERE underlying='PLTR' ORDER BY date_iso DESC LIMIT 20"
- "SELECT underlying, SUM(amount) as pnl, COUNT(*) as trades FROM trades WHERE asset_type='OPTION' GROUP BY underlying ORDER BY pnl DESC"
- "SELECT date_iso, SUM(amount) as daily_pnl FROM trades GROUP BY date_iso ORDER BY date_iso DESC LIMIT 30"
- "SELECT strftime('%w', date_iso) as dow, AVG(amount) as avg_pnl FROM trades WHERE asset_type='OPTION' GROUP BY dow"

## Tool Reference
| Tool | Use when |
|---|---|
| query_trades | Looking up account trades, P&L by ticker, win rates, history |
| save_journal_entry | Creating or updating a dated trading journal entry in the local journal |
| save_note | User says "remember this" / "add this to your memory" / pastes reference content to save — NOT trade-specific |
| get_account_snapshot | Pulling current balances, open positions, and live risk exposure from Schwab |
| get_quote | Need current price, bid/ask, volume, momentum before any trade idea |
| get_options_chain | Need live IV, strikes, greeks, OI — for trade setup or risk assessment |
| get_price_history | Need trend direction, support/resistance, chart output |
| get_market_movers | Scanning for momentum plays, sector rotation, unusual activity |
| get_market_hours | Checking if market is open |
| get_advanced_analytics | Deep wash-sale/tax/fees/losses analytics with projected trends |
| get_market_news | Understanding news catalyst behind a trade outcome |
| web_search | General research, tax rules, concepts, anything else |
| get_trades | Raw fill/leg lookups with structured filters |
| get_positions | Grouped open/closed positions, not raw fills |
| compute_metrics | Win rate, profit factor, expectancy, drawdown, avg hold time, fee drag, Sharpe/Sortino |
| generate_leak_insights | Evidence-backed leak patterns: losing setups, bad days, hold-time effects, fee drag, wash sales |

## Trade Suggestion Workflow
When asked to suggest trades or analyze opportunities, chain these steps:
1. **get_account_snapshot** → live exposures and risk budget available today
2. **query_trades** → trader's history on this ticker: win rate, preferred strikes, avg P&L, strategy patterns
3. **get_quote** → current price, momentum, spread (is it liquid?)
4. **get_price_history** → trend: bullish / bearish / sideways? Key support/resistance levels
5. **get_options_chain** → live IV, best strikes, upcoming expirations, OI clusters (high OI = magnet)
6. **get_market_news** (optional) → any catalyst coming? Earnings? Fed event?
7. **Suggest 2–3 specific trades** ranked by conviction:

For each trade suggestion include:
- **Strategy**: e.g. "Long Call", "Bull Call Spread", "Short Put", "Iron Condor"
- **Entry**: Strike(s), expiry, price range (bid–ask midpoint)
- **Max profit / Max loss / Break-even**
- **Why**: tie it to the price action, IV level, and this trader's history
- **Risk**: what would invalidate this trade (price level, event risk)

## Prediction Framework (Required for "prediction", "edge", "what should I do now")
- Give probabilities, not certainties. Use base/ bull/ bear scenarios with probability weights that sum to 100%.
- Provide expected value logic: EV = p(win)*avg_win - p(loss)*avg_loss - fees/slippage.
- Include confidence score (0-100) and what would raise/lower confidence.
- Explicitly compare idea fit versus both mandates: Strategic Owner (Wheel/dividend-growth accumulation) and Tactical Trader (day/swing opportunity capture).
- Enforce risk controls: max loss per trade, max correlated exposure, event-risk notes.
- If live account snapshot is unavailable, say it and provide a reduced-confidence plan.

## Hybrid Performance Analysis Framework
When asked to evaluate performance, break it into three sections:
1. Strategic Owner Scorecard:
- Wheel cadence quality (CSP entries, assignment quality, covered-call management)
- Income durability (premium consistency + dividend support when known)
- Net profitability after fees and estimated taxes
- Long-term ownership quality (whether assigned assets align with dividend/growth intent)

2. Tactical Trader Scorecard:
- Day/swing hit rate, payoff asymmetry, and holding-period discipline
- Setup quality vs execution quality (entry/exit timing, overtrading, slippage sensitivity)
- Net profitability after fees and estimated taxes

3. Combined Portfolio Attribution:
- Which mandate is driving returns vs drawdowns
- Correlation/concentration overlap between mandates
- Concrete adjustment plan: what to size up, size down, or stop

Always end with a direct verdict:
- "Strategic engine leading / Tactical drag" or
- "Tactical engine leading / Strategic drag" or
- "Both contributing" with quantified evidence when available.

## Trade Impact Analysis Workflow
When asked WHY a trade won or lost:
1. **query_trades** → get ticker, open/close dates, entry/exit prices, P&L
2. **get_market_news** → what happened between those dates
3. **Synthesize** → causal narrative: price moved X% because Y event → position gained/lost Z because [directional logic]

## Tax & CPA Expertise
You also function as a CPA-level tax advisor for this trader's options/equity activity. Apply these rules precisely — never guess on tax mechanics, and never present speculative tax advice as settled law:

- **Wash sale rule (IRC §1091)**: a loss is disallowed if the trader buys the same or a "substantially identical" security (or option on it) within the 61-day window spanning 30 days before through 30 days after the loss sale. The disallowed loss is added to the basis of the replacement shares/contracts and the holding period carries over. Pull this account's actual flagged wash sales from **get_advanced_analytics** — don't hand-calculate from memory.
- **Cost basis — stock splits**: total basis is unchanged by a split; reallocate it evenly across pre- and post-split shares (per-share basis = total basis ÷ total shares after split). No taxable event at the split itself.
- **Cost basis — multiple lots**: for "covered securities" (generally acquired 2011+ through a broker), the broker tracks and reports basis on Form 1099-B. For uncovered/older lots, use specific identification if the trader designated lots at the time of sale, otherwise first-in-first-out (FIFO).
- **Dividend reinvestment (DRIP)**: reinvested dividends are ordinary income in the year credited (Schedule B required if dividends exceed $1,500) and are added to the basis of the shares purchased with them.
- **§423 Employee Stock Purchase Plans**: no income at grant or exercise. On sale, the split between ordinary income (the discount) and capital gain/loss depends on meeting the holding period — the later of 1 year from purchase/transfer or 2 years from grant. Form 3922 documents the transfer.
- **Short sales**: for positions opened after Jan 1, 2011, Form 1099-B reports proceeds and basis together at the closing trade — reconcile against Form 8949 for the year the short is *closed*, not opened. Pre-2011 shorts use the original 1099-B basis data.
- **Options taxation basics**: premium received for writing (STO) an option isn't taxed until it expires, is closed (BTC), or is exercised/assigned — at which point it adjusts the option's own gain/loss or rolls into the underlying's basis. Long option premium paid is a capital cost recovered on sale, expiration, or exercise. Short-term vs. long-term follows the option's own holding period, except on exercise, where the premium rolls into the underlying's basis and the underlying's holding period governs.
- **Form 8949 categorization**: this app's journal Form 8949 output already computes short/long-term classification and wash-sale disallowed amounts per symbol from the account's real trade history — defer to that (or **get_advanced_analytics**) over ad-hoc math, and be explicit that it does not yet assign IRS box A/B/C (covered vs. uncovered, basis reported to IRS or not); the trader still needs to confirm that against their broker's 1099-B before filing.
- **Source**: IRS FAQ — Stocks (Options, Splits, Traders): https://www.irs.gov/faqs/capital-gains-losses-and-sale-of-home/stocks-options-splits-traders. For anything outside that FAQ or this app's computed data, say so plainly and recommend the trader confirm with a licensed CPA.

## Deep Analytics Workflow
When asked about wash sales, estimated taxes, fee drag, loss clusters, or projected trend:
1. Use **get_advanced_analytics** first.
2. Base your explanation on that output (not guesses).
3. Include at least one chart block when there are time-series or category comparisons.
4. If [ADVANCED_ANALYTICS_CONTEXT] is present in the user message, treat it as authoritative computed data from the account.

## Journal Workflow
- If the user asks to add, save, update, or log a trading journal entry, use **save_journal_entry**.
- Prefer explicit dates and symbols. Preserve the user's wording in notes/thesis/lessons unless cleanup is necessary.
- Confirm what was saved, including date and symbol.

## Memory Workflow
- If the user says "remember this," "add this to your memory," "save this note," "keep this in mind," or pastes reference content and asks you to hold onto it — use **save_note**, not save_journal_entry (that's for dated, trade-specific entries only).
- Pass the content through close to verbatim — don't summarize away specifics the user may want back later. A short title helps future retrieval but isn't required.
- Confirm what was saved in one line. Don't re-explain the content back at length — the point was to store it, not discuss it, unless the user also asked a question about it.

Directional logic reminders: rising stock = calls gain / puts lose; falling stock = puts gain / calls lose; IV crush post-earnings = premium sellers win, buyers lose; high IV entering = expensive options, favor selling; low IV = cheap options, favor buying.

## Charts & Visual Output
The chat UI renders \`\`\`chart code blocks as live Chart.js charts. Use them proactively when showing comparisons, P&L breakdowns, distributions, or time series — a chart communicates more than a table when there are 4+ data points.

**Chart types:** bar, line, pie, doughnut, horizontalBar

**Format (single dataset):**
\`\`\`chart
{"type":"bar","title":"Net P&L by Ticker","labels":["PLTR","SPY","NVDA"],"data":[425.50,-118.30,892.00]}
\`\`\`

**Format (multiple datasets):**
\`\`\`chart
{"type":"bar","title":"Wins vs Losses by Month","labels":["Jan","Feb","Mar"],"datasets":[{"label":"Wins","data":[320,180,550]},{"label":"Losses","data":[-80,-240,-60]}]}
\`\`\`

**Format (pie / doughnut):**
\`\`\`chart
{"type":"doughnut","title":"Win Rate","labels":["Wins","Losses"],"data":[23,8]}
\`\`\`

**Format (line — cumulative P&L):**
\`\`\`chart
{"type":"line","title":"Cumulative P&L","labels":["Jan","Feb","Mar","Apr"],"data":[320,180,700,620],"prefix":"$"}
\`\`\`

**When to use:**
- P&L by ticker → bar chart
- Monthly P&L over time → line chart
- Win/loss breakdown → doughnut or horizontal bar
- Best vs worst trades → horizontal bar
- Day-of-week profitability → bar chart
- Trade distribution → bar chart

Always use real numbers from query_trades — never fabricate chart data.

${statsContext}

${styleContext}

${liveAccountContext}`;

  // Assemble the user message — inject pre-fetched news or RAG context
  let userMessage = message;
  const deepAnalyticsIntent = isDeepAnalyticsRequest(message);
  const advancedAnalyticsContext = deepAnalyticsIntent
    ? toolGetAdvancedAnalytics({})
    : '';
  // The live account snapshot already lives in the system prompt (liveAccountContext,
  // below), but confirmed in practice that a small/mid model weights context sitting
  // next to the actual question far more than something stated earlier in a long
  // system prompt — a real "how is the portfolio doing today" question got answered
  // from stale RAG monthly-P&L chunks instead of this real-time data, because RAG
  // context sits right next to the question and the live snapshot didn't. Repeating a
  // condensed version here, in the user turn, puts it on equal footing.
  const liveSnapshotReminder = `[CURRENT REAL-TIME ACCOUNT SNAPSHOT — as of ${todayStr}]\n${liveAccountContext}\nThis is the ONLY source for "today"/"current"/"right now" portfolio status. Any records or summaries below (RAG, journal, monthly aggregates) are HISTORICAL — never present them as today's status.\n\n---\n\n`;
  if (prefetchedNews) {
    userMessage = `${liveSnapshotReminder}[LIVE WEB RESULTS for "${message}"]:\n\n${prefetchedNews}\n\n---\n\nUsing the web results above, answer my question: ${message}`;
  } else if (ragContext) {
    userMessage = `${liveSnapshotReminder}Here are the relevant records from my trading account:\n\n${ragContext}\n\n---\n\n${message}`;
  } else {
    userMessage = `${liveSnapshotReminder}${message}`;
  }
  if (advancedAnalyticsContext) {
    userMessage = `${userMessage}\n\n[ADVANCED_ANALYTICS_CONTEXT]\n${advancedAnalyticsContext}`;
  }

  // query_trades tool — always available (local DB)
  const tradeTools = [
    {
      type: 'function',
      function: {
        name: 'query_trades',
        description: 'Run a read-only SQL SELECT query against the local trades database to look up specific trades, calculate custom metrics, filter by date/ticker/action, or perform any ad-hoc analysis. Consider calling search_vault first for questions you may have already answered before.',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'A valid SQLite SELECT statement. Only SELECT is permitted.' },
            intent: { type: 'string', description: 'Optional short human-language description of what this query answers (e.g. "win rate on TSLA options"). When given, a successful query is saved to the query vault under this intent so it can be reused next time a similar question comes up.' },
          },
          required: ['sql'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_vault',
        description: 'Check the query vault for a past query_trades SQL statement that already answers a similar question, BEFORE writing new SQL. If a close match comes back, reuse its sql_query directly with query_trades instead of re-deriving it from scratch.',
        parameters: {
          type: 'object',
          properties: {
            intent: { type: 'string', description: 'Short human-language description of what you are trying to look up, e.g. "win rate on TSLA options".' },
            top_n: { type: 'number', description: 'Max number of matches to return (default 3).' },
          },
          required: ['intent'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_journal_entry',
        description: 'Create or update a trading journal entry in the local journal database. Use for dated notes, trade reviews, lessons learned, and strategy tracking.',
        parameters: {
          type: 'object',
          properties: {
            date:        { type: 'string', description: 'Trade or journal date as YYYY-MM-DD or MM/DD/YYYY.' },
            symbol:      { type: 'string', description: 'Ticker or contract symbol for the entry.' },
            underlying:  { type: 'string', description: 'Underlying ticker, if different from symbol.' },
            action:      { type: 'string', description: 'Optional trade action, e.g. STO, BTC, Buy, Sell.' },
            strategy:    { type: 'string', description: 'Strategy label, e.g. cash-secured put, bull call spread.' },
            notes:       { type: 'string', description: 'Main journal notes or recap.' },
            thesis:      { type: 'string', description: 'Why the trade was entered.' },
            exit_reason: { type: 'string', description: 'Why the trade was exited or how it should be exited.' },
            lessons:     { type: 'string', description: 'Lessons learned from the trade or market read.' },
            rating:      { type: 'number', description: 'Optional self-rating from 0 to 10.' },
            tags:        { type: 'string', description: 'Comma-separated tags.' },
            mistakes:    { type: 'string', description: 'Mistakes or execution issues to remember.' },
          },
          required: ['date', 'symbol', 'notes'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_note',
        description: 'Persist arbitrary knowledge, reference material, or a fact the trader asks you to remember — NOT a trade-specific journal entry (use save_journal_entry for those). Use this whenever the user says things like "remember this", "add this to your memory", "save this note", "keep this in mind", or pastes reference content and asks you to hold onto it. It is embedded and indexed immediately, so it will resurface via RAG search in future conversations when relevant — you do not need to re-save it or ask the user to re-index.',
        parameters: {
          type: 'object',
          properties: {
            title:   { type: 'string', description: 'Short label for the note, e.g. "Sosnoff options strategies". Helps future retrieval; optional but recommended.' },
            content: { type: 'string', description: 'The full content to remember, verbatim or lightly cleaned up — do not summarize away specifics the user may want back later.' },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'propose_correction',
        description: 'Flag a specific field on an EXISTING journal_entries row that is factually wrong (e.g. an underlying mislabeled as the wrong company/ETF, contradicted by the trades table\'s own description field) and propose the correct value. This does NOT write anything — it only surfaces a review card for the user to approve or reject. NEVER call save_journal_entry to "fix" an existing wrong value yourself; that writes immediately with no review and is how bad data gets permanently baked in. Look up the exact entry_id first with query_trades (SELECT entry_id, ... FROM journal_entries WHERE ...).',
        parameters: {
          type: 'object',
          properties: {
            entry_id:       { type: 'string', description: 'Exact entry_id of the journal_entries row to correct, found via query_trades.' },
            field:          { type: 'string', enum: ['symbol', 'underlying', 'strategy', 'notes', 'thesis', 'exit_reason', 'lessons', 'tags', 'mistakes', 'objective'], description: 'Which field is wrong.' },
            proposed_value: { type: 'string', description: 'What the field should actually say.' },
            reason:         { type: 'string', description: 'Why the current value is wrong — cite the evidence, e.g. a real description from the trades table that contradicts it.' },
          },
          required: ['entry_id', 'field', 'proposed_value', 'reason'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_account_snapshot',
        description: 'Get real-time Schwab account balances and open positions. Use this before any prediction or trade recommendation to size risk and avoid overexposure.',
        parameters: {
          type: 'object',
          properties: {
            options_only: { type: 'boolean', description: 'If true, return only option positions. Default false.' },
            top:          { type: 'number',  description: 'How many top positions (by abs market value) to return. Default 20, max 50.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_quote',
        description: 'Get real-time price quotes, bid/ask spread, volume, P/E ratio, and 52-week range for one or more tickers from Schwab. Use before suggesting any trade.',
        parameters: {
          type: 'object',
          properties: {
            symbols: { type: 'string', description: 'Comma-separated tickers, e.g. "PLTR,SPY,NVDA"' },
          },
          required: ['symbols'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_options_chain',
        description: 'Get live options chain with bid/ask, IV, delta, theta, gamma, open interest for a ticker. Use to find specific strikes to trade, assess IV environment, and suggest spreads.',
        parameters: {
          type: 'object',
          properties: {
            symbol:        { type: 'string',  description: 'Underlying ticker, e.g. "PLTR"' },
            contract_type: { type: 'string',  description: '"CALL", "PUT", or "ALL"' },
            strike_count:  { type: 'number',  description: 'Number of strikes above and below ATM to return (default 6)' },
            exp_from:      { type: 'string',  description: 'Start expiry filter YYYY-MM-DD (optional)' },
            exp_to:        { type: 'string',  description: 'End expiry filter YYYY-MM-DD (optional)' },
          },
          required: ['symbol'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_price_history',
        description: 'Get OHLCV price history for a ticker. Returns summary stats and a ready-to-render chart spec. Use to assess trend direction before suggesting a trade.',
        parameters: {
          type: 'object',
          properties: {
            symbol:         { type: 'string', description: 'Ticker symbol' },
            period:         { type: 'number', description: 'Number of periods (default 1)' },
            period_type:    { type: 'string', description: '"day", "month", "year", "ytd" (default "month")' },
            frequency_type: { type: 'string', description: '"minute", "daily", "weekly", "monthly" (default "daily")' },
            frequency:      { type: 'number', description: 'Frequency interval (default 1)' },
          },
          required: ['symbol'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_short_volume',
        description: 'Get official FINRA daily short-sale volume (% of trading volume that was a short sale) for a ticker over its recent trading days. Useful for gauging short-side pressure/positioning around a catalyst. This is short SALE VOLUME (a daily activity metric), not "short interest" (total shares currently sold short, reported biweekly) — never conflate the two.',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Ticker symbol, e.g. "SPCX"' },
            days:   { type: 'number', description: 'Number of most recent trading days to pull (default 5, max 30)' },
          },
          required: ['symbol'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_market_movers',
        description: 'Get top gaining/losing stocks in an index today. Useful for spotting momentum plays and understanding broad market sentiment.',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'string', description: '"$SPX" (S&P 500), "$COMPX" (Nasdaq), "$DJI" (Dow). Default $SPX.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_market_hours',
        description: 'Check if equity and options markets are currently open or closed, and get session hours.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_advanced_analytics',
        description: 'Compute deep account analytics: wash-sale exposure, estimated taxes, fee breakdown, top losses, and projected monthly trends. Use for tax/risk reporting questions.',
        parameters: {
          type: 'object',
          properties: {
            from_date: { type: 'string', description: 'Optional start date YYYY-MM-DD' },
            to_date: { type: 'string', description: 'Optional end date YYYY-MM-DD' },
            ticker: { type: 'string', description: 'Optional ticker filter' },
            fed_st_rate: { type: 'number', description: 'Federal short-term rate as decimal, default 0.32' },
            fed_lt_rate: { type: 'number', description: 'Federal long-term rate as decimal, default 0.15' },
            state_rate: { type: 'number', description: 'State tax rate as decimal, default 0.05' },
            projection_months: { type: 'number', description: 'Projection horizon in months, default 6, max 18' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_trades',
        description: 'Look up raw trade rows (fills/legs) with structured filters. Use for listing specific fills or as input to another tool. For aggregate metrics (win rate, P&L totals, etc.) use compute_metrics instead of summing these yourself.',
        parameters: {
          type: 'object',
          properties: {
            symbol:     { type: 'string', description: 'Underlying ticker, e.g. "PLTR". Matches the underlying column, not the option contract string.' },
            asset_type: { type: 'string', enum: ['OPTION', 'EQUITY', 'ALL'], description: 'Default ALL.' },
            action:     { type: 'string', description: 'Exact action filter, e.g. "Sell to Open", "Buy to Close", "Expired". Omit for all actions.' },
            date_from:  { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
            date_to:    { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
            strategy:   { type: 'string', description: 'Journal-tagged strategy label to filter by, e.g. "cash-secured put".' },
            limit:      { type: 'number', description: 'Max rows to return, default 100, max 500.' },
            sort:       { type: 'string', enum: ['date_asc', 'date_desc', 'amount_asc', 'amount_desc'], description: 'Default date_desc.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_positions',
        description: 'Get positions with open/closed status and net realized P&L. OPTION positions (the default) are ROLL-AWARE: closing one contract and opening another same-underlying, same-right (call/put) contract on the same day is treated as one continuous logical trade — check is_roll/roll_count, and see legs[] for each individual contract\'s own opened/closed/net_pnl within that chain. EQUITY positions are FIFO-matched buy/sell lots (Buy/Sell actions only — splits/transfers/dividends aren\'t lot-adjusted). If has_incomplete_pricing is true, at least one leg has no usable price/amount in this dataset — do not present that position\'s net_pnl as a confident number. Use for "what positions do I have in X" or "list my closed PLTR trades" — not for aggregate stats, which belong in compute_metrics.',
        parameters: {
          type: 'object',
          properties: {
            symbol:     { type: 'string', description: 'Underlying ticker filter.' },
            status:     { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default closed. Use open for currently-held exposure, or prefer get_account_snapshot for live open positions with current market value.' },
            asset_type: { type: 'string', enum: ['OPTION', 'EQUITY', 'ALL'], description: 'Default OPTION.' },
            date_from:  { type: 'string', description: 'Filters by the position\'s opened date, YYYY-MM-DD. A roll chain or equity lot that started before this date but closed after it will not match — the underlying trade fetch itself is never date-truncated, so PnL/hold-time on a matched chain is always computed from its true full history.' },
            date_to:    { type: 'string', description: 'Filters by the position\'s opened date, YYYY-MM-DD.' },
            limit:      { type: 'number', description: 'Default 100, max 500.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'compute_metrics',
        description: 'Compute win rate, profit factor, avg win/loss, expectancy, max drawdown, average hold time, fee drag, roll_count, and (optionally) Sharpe/Sortino over a filtered set of closed positions. Each rolled OPTION chain counts as ONE trade (aggregate P&L/hold-time across every leg), not one win/loss per leg — this is the tool for any "how am I doing" / "what\'s my win rate on X" / "am I profitable" question. Never hand-calculate these from get_trades or query_trades rows yourself, and never sum leg-level P&L for a rolled position by hand. Closed positions with no usable pricing (see has_incomplete_pricing in get_positions) are excluded and reported in the response\'s caveat field rather than counted as $0.',
        parameters: {
          type: 'object',
          properties: {
            symbol:          { type: 'string' },
            asset_type:      { type: 'string', enum: ['OPTION', 'EQUITY', 'ALL'], description: 'Default OPTION.' },
            strategy:        { type: 'string', description: 'Journal-tagged strategy label.' },
            date_from:       { type: 'string', description: 'YYYY-MM-DD, filters by each position\'s opened date (see get_positions for the same caveat on roll chains spanning the boundary).' },
            date_to:         { type: 'string', description: 'YYYY-MM-DD' },
            metrics:         { type: 'array', items: { type: 'string', enum: ['win_rate', 'profit_factor', 'avg_win', 'avg_loss', 'expectancy', 'max_drawdown', 'avg_hold_days', 'trade_count', 'realized_pnl', 'total_fees', 'fee_drag_pct', 'sharpe_ratio', 'sortino_ratio', 'roll_count', 'all'] }, description: 'Which metrics to compute. Default all.' },
            risk_free_rate:  { type: 'number', description: 'Annualized risk-free rate as a decimal, default 0.05. Only used for sharpe_ratio/sortino_ratio.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_leak_insights',
        description: 'Find deterministic, evidence-backed patterns behind underperformance: a losing setup traded too often, a bad day-of-week, positions held too long, elevated fee drag, or wash-sale-disallowed losses. Use for "what patterns show up in my trading" or "where am I leaking money." This is account-wide analysis (not fully filterable by symbol/date — see each insight\'s evidence for what it actually covers), not a ranked list of individual trades — for that, use get_positions sorted by net_pnl.',
        parameters: {
          type: 'object',
          properties: {
            symbol:         { type: 'string', description: 'Only narrows the wash_sale_drag leak type — the others are whole-account.' },
            date_from:      { type: 'string', description: 'Only narrows the wash_sale_drag leak type.' },
            date_to:        { type: 'string', description: 'Only narrows the wash_sale_drag leak type.' },
            min_confidence: { type: 'number', description: 'Minimum confidence (0-1, sample-size based, not statistical significance) for an insight to be returned. Default 0.' },
            max_insights:   { type: 'number', description: 'Default 10, max 50.' },
            leak_types:     { type: 'array', items: { type: 'string', enum: ['underperforming_setup', 'day_of_week_drag', 'hold_time_effect', 'fee_drag', 'wash_sale_drag'] }, description: 'Filter to specific leak categories. Omit for all types.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_truth_check',
        description: 'Look up everything Proactive Scout already has on file for a ticker: what 10-K/10-Q/20-F/6-K filings are on file, up to 5 recent insider (Form 4) transactions, up to 5 recent Finnhub news items, the latest crawled market sentiment (from reputable financial outlets), and the latest "Truth Check" — a verdict (favorable/neutral/caution/high_risk) on whether current sentiment is justified by what the filing actually discloses, with specific contradictions (Risk Factors vs MD&A), citations, and dilution/priority-of-claims/cash-flow-sensitivity analysis. Use this for ANY ticker-specific question — SEC filing risk, insider buying/selling, recent news, whether sentiment matches the filing, dilution risk, or a "truth check"/verdict — before reaching for web_search, since this is real data already computed and stored, not something to re-derive. Trust-rank what it returns the same way the dashboards do: sec_filings_on_file and recent_insider_activity are SEC-filed (highest confidence), recent_news is a structured third-party API (Finnhub), latest_sentiment is crawled web text (lowest confidence, no source guarantee). This is a read-only lookup of data already on file — it does not run a new analysis. If nothing is on file, tell the user to run one from the /scout dashboard.',
        parameters: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'Stock ticker symbol, e.g. "RKLB"' },
          },
          required: ['ticker'],
        },
      },
    },
  ];

  // web_search + get_market_news — offered when either search provider is configured
  const searchTools = (OLLAMA_API_KEY || PERPLEXITY_API_KEY) ? [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for general information, current prices, tax rules, or anything not covered by get_market_news.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_market_news',
        description: 'Fetch market news, earnings reports, analyst upgrades/downgrades, and catalysts for a specific ticker around a date range. Use this to understand what news events drove a trade outcome — positive or negative.',
        parameters: {
          type: 'object',
          properties: {
            ticker:    { type: 'string', description: 'Stock ticker symbol, e.g. "PLTR" or "SPY"' },
            date_from: { type: 'string', description: 'Start date YYYY-MM-DD (the trade open date)' },
            date_to:   { type: 'string', description: 'End date YYYY-MM-DD (the trade close or expiry date). Optional.' },
            topic:     { type: 'string', description: 'Optional focus topic: "earnings", "FDA approval", "analyst upgrade", "macro", etc.' },
          },
          required: ['ticker', 'date_from'],
        },
      },
    },
  ] : [];

  const tools = [...tradeTools, ...searchTools];

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage },
    ];

    let reply = '(no response)';
    let suggestedJournal = null;
    let proposedCorrection = null;
    let webSearchUsed = false;
    let usedDeterministicStrategy = false;

    // "Remember this" wins over every other intent check below — a pasted
    // article being saved as a note can trigger any of their keyword regexes
    // by coincidence (this is exactly what happened: an options-strategies
    // article contained literal "Strategy N:" headers and got hijacked into
    // a trade-recommendation reply instead of ever reaching save_note).
    const memoryIntent = isMemoryRequest(message);

    // ── Deterministic memory-save short-circuit ───────────────────────────────
    // Highest priority — see generateMemorySaveReply's comment for why this
    // isn't left to the model's tool-choice.
    if (memoryIntent) {
      const memoryReply = await generateMemorySaveReply({ message });
      if (memoryReply) { reply = memoryReply; usedDeterministicStrategy = true; }
    }

    // ── Proactive Quant Strategist short-circuit ───────────────────────────────
    // Forward-looking trade questions always get the enforced data → synthesis
    // chain (account snapshot → quote → price history → options chain →
    // recommendation) run directly, rather than leaving it up to the model to
    // decide whether to call those tools. This is what makes the agent lead
    // with data and conclude with a concrete recommendation every time, not
    // just when it happens to choose the right tools.
    if (!memoryIntent && isStrategyRequest(message)) {
      const fallback = await generateActionableStrategyFallback({ message });
      if (fallback) { reply = fallback; usedDeterministicStrategy = true; }
    }

    // ── Deterministic short-exposure short-circuit ───────────────────────────
    // "How shorted is X" should come from live account positions directly,
    // not an options-chain lookup that can fail or target the wrong symbol.
    if (!usedDeterministicStrategy && !memoryIntent && isShortExposureRequest(message)) {
      const shortReply = await generateShortExposureReply({ message });
      if (shortReply) { reply = shortReply; usedDeterministicStrategy = true; }
    }

    // ── Deterministic Proactive Scout lookup short-circuit ───────────────────
    // Ticker-scoped questions about Truth Check / insider activity / SEC filings /
    // Scout's news feed pull the already-computed data directly instead of relying
    // on the model to call get_truth_check — confirmed it doesn't reliably do so
    // (see isScoutLookupRequest comment for the two live failures that prompted this).
    if (!usedDeterministicStrategy && !memoryIntent && isScoutLookupRequest(message)) {
      const scoutReply = generateScoutLookupReply({ message });
      if (scoutReply) { reply = scoutReply; usedDeterministicStrategy = true; }
    }

    // ── Deterministic deep-analytics short-circuit ────────────────────────────
    // Tax / wash-sale / fee-drag / loss-cluster / projection questions should
    // always return the computed analytics dataset directly, even when the
    // model fails to invoke tools correctly and only prints pseudo tool JSON.
    if (!usedDeterministicStrategy && !memoryIntent && isDeepAnalyticsRequest(message)) {
      const analyticsReply = generateDeepAnalyticsReply({ message });
      if (analyticsReply) { reply = analyticsReply; usedDeterministicStrategy = true; }
    }

    // ── Deterministic portfolio-status short-circuit ──────────────────────────
    // "How is my portfolio doing today" must come from the live account snapshot
    // directly — confirmed the model ignores it even when correctly positioned
    // in-prompt and answers from stale RAG monthly summaries instead.
    if (!usedDeterministicStrategy && !memoryIntent && isPortfolioStatusRequest(message)) {
      const statusReply = await generatePortfolioStatusReply();
      if (statusReply) { reply = statusReply; usedDeterministicStrategy = true; }
    }

    // ── Deterministic metrics short-circuit ───────────────────────────────────
    // "Win rate on X" / "profit factor" / etc. — confirmed the model computes these
    // from a handful of RAG-retrieved records instead of calling compute_metrics,
    // producing numbers nearly 2x off from the real figure. One correct answer exists;
    // don't let any model re-derive it.
    if (!usedDeterministicStrategy && !memoryIntent && isMetricsRequest(message)) {
      const metricsReply = generateMetricsReply({ message });
      if (metricsReply) { reply = metricsReply; usedDeterministicStrategy = true; }
    }

    // Tool-calling loop — max 5 rounds (agent may chain query_trades + web_search).
    // A crash on chatModel falls back to CHAT_MODEL_FALLBACK once; if the fallback
    // is the one that succeeds, chatModel is updated so every later round in this
    // same request (and the post-hoc journal-draft call below) keeps using it
    // instead of re-hitting the model that just crashed.
    for (let round = 0; !usedDeterministicStrategy && round < 5; round++) {
      const body = { messages, stream: false, options: { temperature: CHAT_TEMPERATURE } };
      if (tools.length) body.tools = tools;

      let data, modelUsed;
      try {
        ({ data, modelUsed } = await ollamaChatWithFallback(chatModel, CHAT_MODEL_FALLBACK, body, OLLAMA_CHAT_TIMEOUT_MS));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      if (modelUsed !== chatModel) {
        console.log(`[chat] switched to fallback model for the rest of this request: ${modelUsed}`);
        chatModel = modelUsed;
      }
      const assistantMsg = data.message || {};

      // Check for tool calls
      if (assistantMsg.tool_calls?.length) {
        console.log(`[chat] round ${round + 1}/5 — tool calls: ${assistantMsg.tool_calls.map(c => c.function?.name).join(', ')}`);
        messages.push({ role: 'assistant', content: assistantMsg.content || '', tool_calls: assistantMsg.tool_calls });
        for (const call of assistantMsg.tool_calls) {
          if (call.function?.name === 'web_search') {
            const query = call.function.arguments?.query || message;
            const searchResult = await webSearch(query);
            webSearchUsed = true;
            messages.push({ role: 'tool', content: searchResult || 'No results found.' });
          } else if (call.function?.name === 'get_market_news') {
            const { ticker, date_from, date_to, topic } = call.function.arguments || {};
            const newsResult = await getMarketNews(ticker, date_from, date_to, topic);
            webSearchUsed = true;
            messages.push({ role: 'tool', content: newsResult || `No news found for ${ticker} around ${date_from}.` });
          } else if (call.function?.name === 'query_trades') {
            const { sql = '', intent } = call.function.arguments || {};
            const result = queryTrades(sql);
            const failed = typeof result === 'string' && (result.startsWith('ERROR:') || result.startsWith('SQL ERROR:'));
            if (intent && !failed) recordVaultSuccess(intent, sql);
            messages.push({ role: 'tool', content: result });
          } else if (call.function?.name === 'search_vault') {
            const { intent, top_n } = call.function.arguments || {};
            const matches = matchVaultIntent(intent || '', { topN: Number(top_n) || 3 });
            const content = matches.length
              ? matches.map(m => `[match ${m.match_score}] "${m.intent}" -> ${m.sql_query}`).join('\n')
              : 'No sufficiently similar past query found in the vault — write new SQL for query_trades.';
            messages.push({ role: 'tool', content });
          } else if (call.function?.name === 'save_journal_entry') {
            messages.push({ role: 'tool', content: saveJournalEntry(call.function.arguments || {}) });
          } else if (call.function?.name === 'save_note') {
            messages.push({ role: 'tool', content: await toolSaveNote(call.function.arguments || {}) });
          } else if (call.function?.name === 'propose_correction') {
            const result = proposeCorrection(call.function.arguments || {});
            if (result.ok) proposedCorrection = result;
            messages.push({ role: 'tool', content: JSON.stringify(result) });
          } else if (call.function?.name === 'get_account_snapshot') {
            const { options_only, top } = call.function.arguments || {};
            messages.push({ role: 'tool', content: await toolGetAccountSnapshot(!!options_only, Number(top || 20)) });
          } else if (call.function?.name === 'get_quote') {
            const { symbols } = call.function.arguments || {};
            messages.push({ role: 'tool', content: await toolGetQuote(symbols || '') });
          } else if (call.function?.name === 'get_options_chain') {
            const { symbol, contract_type, strike_count, exp_from, exp_to } = call.function.arguments || {};
            messages.push({ role: 'tool', content: await toolGetOptionsChain(symbol, contract_type, strike_count, exp_from, exp_to) });
          } else if (call.function?.name === 'get_price_history') {
            const { symbol, period, period_type, frequency_type, frequency } = call.function.arguments || {};
            messages.push({ role: 'tool', content: await toolGetPriceHistory(symbol, period, period_type, frequency_type, frequency) });
          } else if (call.function?.name === 'get_short_volume') {
            const { symbol, days } = call.function.arguments || {};
            messages.push({ role: 'tool', content: await toolGetShortVolume(symbol, days) });
          } else if (call.function?.name === 'get_market_movers') {
            const { index } = call.function.arguments || {};
            messages.push({ role: 'tool', content: await toolGetMarketMovers(index) });
          } else if (call.function?.name === 'get_market_hours') {
            messages.push({ role: 'tool', content: await toolGetMarketHours() });
          } else if (call.function?.name === 'get_advanced_analytics') {
            messages.push({ role: 'tool', content: toolGetAdvancedAnalytics(call.function.arguments || {}) });
          } else if (call.function?.name === 'get_trades') {
            messages.push({ role: 'tool', content: JSON.stringify(toolGetTrades(call.function.arguments || {})) });
          } else if (call.function?.name === 'get_positions') {
            messages.push({ role: 'tool', content: JSON.stringify(toolGetPositions(call.function.arguments || {})) });
          } else if (call.function?.name === 'compute_metrics') {
            messages.push({ role: 'tool', content: JSON.stringify(toolComputeMetrics(call.function.arguments || {})) });
          } else if (call.function?.name === 'generate_leak_insights') {
            messages.push({ role: 'tool', content: JSON.stringify(toolGenerateLeakInsights(call.function.arguments || {})) });
          } else if (call.function?.name === 'get_truth_check') {
            const { ticker } = call.function.arguments || {};
            messages.push({ role: 'tool', content: JSON.stringify(toolGetTruthCheck(ticker)) });
          }
        }
        // Continue loop to let model formulate final answer
      } else {
        reply = assistantMsg.content || data.response || '(no response)';
        break;
      }
    }

    // If every round kept calling tools and the loop hit its 5-round cap
    // without the model ever producing a final answer, `reply` is still
    // stuck at its initial placeholder — replace it with something honest
    // instead of shipping a bare "(no response)" to the user.
    if (reply === '(no response)') {
      console.log('[chat] tool-calling loop exhausted 5 rounds without a final answer');
      reply = "I gathered information across several tool calls but ran out of reasoning rounds before forming a complete answer. Try breaking this into a narrower, more specific question.";
    }

    suggestedJournal = await generateJournalDraft(message, reply, chatModel);

    res.json({
      reply,
      ragUsed:         ragContext.length > 0,
      ragResults:      ragResults.length,
      webSearchUsed:   webSearchUsed || prefetchedNews.length > 0,
      prefetchedNews:  prefetchedNews.length > 0,
      suggestedJournal,
      proposedCorrection,
    });
  } catch (err) {
    res.status(500).json({ error: `Could not reach Ollama at ${OLLAMA_HOST}: ${err.message}` });
  }
});

// ── OAuth: start ──────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id',     CLIENT_ID);
  url.searchParams.set('redirect_uri',  REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         'readonly');
  url.searchParams.set('state',         state);
  res.redirect(url.toString());
});

// ── OAuth: callback ───────────────────────────────────────────────────────────
app.get('/api/auth/schwab/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !states.has(state)) return res.redirect('/');
  states.delete(state);
  try {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    });
    const tokens = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(tokens));
    saveTokens(tokens);
    console.log('✅  Schwab authenticated — tokens saved');
  } catch (err) { console.error('❌  OAuth callback failed:', err.message); }
  res.redirect('/');
});

// ── Gmail OAuth (mirrors the Schwab flow above) ────────────────────────────────
app.get('/auth/gmail', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in local/.env — see README.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id',     GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri',  GMAIL_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         GMAIL_SCOPE);
  url.searchParams.set('state',         state);
  // access_type=offline + prompt=consent: Google only returns a refresh_token on the
  // FIRST grant unless prompt=consent forces the consent screen every time — without
  // this, re-authorizing (e.g. after revoking access) silently gets no refresh_token
  // and the server-side flow breaks with no clear error until the access_token expires.
  url.searchParams.set('access_type',   'offline');
  url.searchParams.set('prompt',        'consent');
  res.redirect(url.toString());
});

app.get('/api/auth/gmail/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !states.has(state)) return res.redirect('/scout');
  states.delete(state);
  try {
    const r = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: GMAIL_REDIRECT_URI,
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      }),
    });
    const tokens = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(tokens));
    if (!tokens.refresh_token) {
      console.warn('⚠️  Gmail authorized but no refresh_token returned — this app was likely already authorized once before. Revoke access at https://myaccount.google.com/permissions and try /auth/gmail again.');
    }
    saveGmailTokens(tokens);
    console.log('✅  Gmail authenticated — tokens saved');
  } catch (err) { console.error('❌  Gmail OAuth callback failed:', err.message); }
  res.redirect('/scout');
});

app.get('/api/auth/gmail/status', (req, res) => {
  const tokens = loadGmailTokens();
  res.json({
    configured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GMAIL_SEND_TO),
    connected: !!tokens?.refresh_token,
    sendTo: GMAIL_SEND_TO || null,
  });
});

// ── Download CSV ──────────────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  if (!fs.existsSync(CSV_FILE)) return res.status(404).send('No CSV yet.');
  res.download(CSV_FILE, 'schwab-import.csv');
});

// ── Serve enhancement script ──────────────────────────────────────────────────
app.get('/local-enhance.js', (req, res) => {
  const f = path.join(__dirname, 'local-enhance.js');
  res.setHeader('Content-Type', 'application/javascript');
  res.send(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '/* local-enhance.js not found */');
});

// ── Professional analytics dashboard at / ────────────────────────────────────
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'local-dashboard.html');
  if (!fs.existsSync(f)) return res.status(500).send('local-dashboard.html not found in container.');
  res.setHeader('Content-Type', 'text/html');
  res.send(fs.readFileSync(f, 'utf8'));
});

// ── Proactive Scout standalone page at /scout ─────────────────────────────────
app.get('/scout', (req, res) => {
  const f = path.join(__dirname, 'scout-dashboard.html');
  if (!fs.existsSync(f)) return res.status(500).send('scout-dashboard.html not found in container.');
  res.setHeader('Content-Type', 'text/html');
  res.send(fs.readFileSync(f, 'utf8'));
});

// OS Sentiment Terminal — standalone public page, same-origin so its fetch('/api/...')
// calls work unmodified when Caddy reverse-proxies straight to this container (same
// pattern as /chamuco → POST /api/v1/ingest). Only ever calls /api/scout/* — no
// Schwab-touching route (/api/account, /api/positions, /api/quote) is referenced.
app.get(['/osterm', '/osterm.html'], (req, res) => {
  const f = path.join(__dirname, 'osterm.html');
  if (!fs.existsSync(f)) return res.status(500).send('osterm.html not found in container.');
  res.setHeader('Content-Type', 'text/html');
  res.send(fs.readFileSync(f, 'utf8'));
});


// ── Static files (webapp assets + local dashboard assets) ─────────────────────
app.use(express.static(WEBAPP_DIR));

// ── Start ─────────────────────────────────────────────────────────────────────
https.createServer(ssl, app).listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  TG-Capital Local at https://127.0.0.1:${PORT}`);
  console.log(`   Open: https://127.0.0.1:${PORT}/`);
  console.log(`   Type "thisisunsafe" in Edge on the cert warning\n`);
});
