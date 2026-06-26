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
 */

require('dotenv').config();
const express        = require('express');
const https          = require('https');
// Node 22 built-in fetch — node-fetch v2 throws "Premature close" on Ollama responses
const fs             = require('fs');
const path           = require('path');
const rag            = require('./rag.js');
const crypto         = require('crypto');
const { execSync }   = require('child_process');
const Database       = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.SCHWAB_CLIENT_ID;
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET;
const OLLAMA_HOST   = process.env.OLLAMA_HOST  || 'http://host.docker.internal:11434';
const CHAT_MODEL    = process.env.CHAT_MODEL   || '0xroyce/plutus';
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
const PORT          = 8080;
const REDIRECT_URI  = `https://127.0.0.1:${PORT}/api/auth/schwab/callback`;
const AUTH_URL      = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL     = 'https://api.schwabapi.com/v1/oauth/token';
const API_BASE      = 'https://api.schwabapi.com/trader/v1';

const DATA_DIR    = path.join(__dirname, 'data');
const CERTS_DIR   = path.join(__dirname, 'certs');
const WEBAPP_DIR  = path.join(__dirname, 'webapp');
const TOKEN_FILE  = path.join(DATA_DIR, 'tokens.json');
const HASH_FILE   = path.join(DATA_DIR, 'account-hash.json');
const CSV_FILE    = path.join(DATA_DIR, 'schwab-import.csv');
const STATUS_FILE = path.join(DATA_DIR, 'sync-status.json');
const DB_FILE     = path.join(DATA_DIR, 'trades.db');

[DATA_DIR, CERTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

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
      ];
    }));
    console.log(`📥  Seeded SQLite from existing CSV: ${rows.length} rows`);
  } catch (e) { console.warn('CSV seed skipped:', e.message); }
}

const stmtUpsert = db.prepare(`
  INSERT OR IGNORE INTO trades
    (date_csv, date_iso, action, symbol, underlying, asset_type, description, quantity, price, fees, amount)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtInsertMany = db.transaction((rows) => {
  for (const r of rows) stmtUpsert.run(r);
});
seedDBFromCSV();
rag.initRag(db);       // create rag_docs + journal_entries tables

// ── Journal schema migration (add IRS fields if not present) ─────────────────
['thesis TEXT DEFAULT ""', 'exit_reason TEXT DEFAULT ""', 'lessons TEXT DEFAULT ""',
 'rating INTEGER DEFAULT 0', 'tags TEXT DEFAULT ""', 'mistakes TEXT DEFAULT ""'
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
    ]));

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
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
app.get('/api/account', async (req, res) => {
  try {
    const token = await getAccessToken();
    const acct  = await getAccountHash(token);
    const r     = await fetch(`${API_BASE}/accounts/${acct.hash}?fields=positions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: JSON.stringify(data) });

    const sa  = data.securitiesAccount || {};
    const bal = sa.currentBalances     || {};

    const positions = (sa.positions || []).map(p => ({
      symbol:      p.instrument?.symbol      || '—',
      description: p.instrument?.description || '',
      assetType:   p.instrument?.assetType   || '',
      putCall:     p.instrument?.putCall     || null,
      underlying:  p.instrument?.underlyingSymbol || null,
      longQty:     p.longQuantity   || 0,
      shortQty:    p.shortQuantity  || 0,
      avgPrice:    p.averagePrice   || p.averageShortPrice || 0,
      marketValue: p.marketValue    || 0,
      dayPnl:      p.currentDayProfitLoss || 0,
      openPnl:     (p.longOpenProfitLoss || 0) + (p.shortOpenProfitLoss || 0),
    }));

    const totalDayPnl  = positions.reduce((s, p) => s + p.dayPnl,  0);
    const totalOpenPnl = positions.reduce((s, p) => s + p.openPnl, 0);

    res.json({
      accountNumber:    acct.accountNumber,
      timestamp:        new Date().toISOString(),
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
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: live positions (kept for compatibility) ───────────────────────────────
app.get('/api/positions', async (req, res) => {
  try {
    const token = await getAccessToken();
    const acct  = await getAccountHash(token);
    const r     = await fetch(`${API_BASE}/accounts/${acct.hash}?fields=positions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: JSON.stringify(data) });
    res.json((data.securitiesAccount?.positions || []).map(p => ({
      symbol:      p.instrument?.symbol      || '—',
      description: p.instrument?.description || '',
      assetType:   p.instrument?.assetType   || '',
      putCall:     p.instrument?.putCall     || null,
      underlying:  p.instrument?.underlyingSymbol || null,
      longQty:     p.longQuantity   || 0,
      shortQty:    p.shortQuantity  || 0,
      avgPrice:    p.averagePrice   || p.averageShortPrice || 0,
      marketValue: p.marketValue    || 0,
      dayPnl:      p.currentDayProfitLoss || 0,
      openPnl:     (p.longOpenProfitLoss || 0) + (p.shortOpenProfitLoss || 0),
    })));
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
             j.lessons, j.rating, j.tags, j.mistakes, j.saved_at
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
        ];
      }).filter(Boolean);

    } else if (format === 'json') {
      // Accept array of objects with same shape as CSV rows, or Schwab API transaction shape
      const items = typeof content === 'string' ? JSON.parse(content) : content;
      if (!Array.isArray(items)) return res.status(400).json({ error: 'JSON must be an array' });
      rows = items.map(r => {
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
          r.underlying || extractUnderlying(symbol),
          r.assetType || r.asset_type || (isOption ? 'OPTION' : 'EQUITY'),
          r.Description || r.description || '',
          parseFloat(r.Quantity || r.quantity) || 0,
          parseFloat(r.Price    || r.price)    || 0,
          parseFloat(r['Fees & Comm'] || r.fees) || 0,
          parseFloat(r.Amount   || r.amount)   || 0,
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

    res.json({ ok: true, inserted, total: after, skipped: rows.length - inserted,
               message: `Imported ${inserted} new rows (${rows.length - inserted} duplicates skipped)` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: journal — save full journal entry ────────────────────────────────────
app.post('/api/journal/save', (req, res) => {
  try {
    const { symbol, underlying, strategy='', notes='', thesis='', exit_reason='', lessons='', rating=0, tags='', mistakes='' } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    db.prepare(`
      INSERT INTO journal_entries (entry_id, symbol, underlying, strategy, notes, thesis, exit_reason, lessons, rating, tags, mistakes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        strategy=excluded.strategy, notes=excluded.notes,
        thesis=excluded.thesis, exit_reason=excluded.exit_reason,
        lessons=excluded.lessons, rating=excluded.rating,
        tags=excluded.tags, mistakes=excluded.mistakes,
        saved_at=datetime('now')
    `).run(symbol, symbol, underlying||null, strategy, notes, thesis, exit_reason, lessons, +rating, tags, mistakes);
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

// ── API: Ollama chat with RAG ─────────────────────────────────────────────────
app.post('/api/ai/chat', async (req, res) => {
  const { message, model, history = [] } = req.body;
  const chatModel = model || CHAT_MODEL;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided' });

  // ── 1. Aggregate stats (always included) ──────────────────────────────────
  let statsContext = 'No trade data yet — run a Schwab sync first.';
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
  } catch {}

  // ── 2. RAG retrieval (semantic search over trades + journal) ───────────────
  let ragContext = '';
  let ragResults = [];
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

  // ── 3. Build prompt ────────────────────────────────────────────────────────
  const systemPrompt = `You are Plutus, a personal AI trading analyst for an options trader using Charles Schwab.
Answer questions using ONLY the trade data and records provided in the context below.
Never invent dates, tickers, P&L figures, or statistics. If a question can't be answered from the provided data, say so.

${statsContext}`;

  // Embed context directly in the user message so finance-tuned models can't ignore it
  const userMessage = ragContext
    ? `${ragContext}\n\n---\nUsing ONLY the data above, answer this question: ${message}`
    : message;

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage },
    ];
    const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: chatModel, messages, stream: false }),
      signal:  AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(500).json({ error: `Ollama error: ${errText}` });
    }
    const data = await r.json();
    res.json({
      reply:      data.message?.content || data.response || '(no response)',
      ragUsed:    ragContext.length > 0,
      ragResults: ragResults.length,
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


// ── Static files (webapp assets + local dashboard assets) ─────────────────────
app.use(express.static(WEBAPP_DIR));

// ── Start ─────────────────────────────────────────────────────────────────────
https.createServer(ssl, app).listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  TG-Capital Local at https://127.0.0.1:${PORT}`);
  console.log(`   Open: https://127.0.0.1:${PORT}/`);
  console.log(`   Type "thisisunsafe" in Edge on the cert warning\n`);
});
