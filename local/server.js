/**
 * TG-Capital Local Server
 * - HTTPS on :8080 (Schwab OAuth requires HTTPS for 127.0.0.1 callbacks)
 * - GET  /          → status dashboard
 * - GET  /auth      → start Schwab OAuth flow
 * - GET  /api/auth/schwab/callback → OAuth callback
 * - POST /sync      → pull latest transactions → write /data/schwab-import.csv
 * - GET  /download  → download the generated CSV
 */

require('dotenv').config();
const express = require('express');
const https   = require('https');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const CLIENT_ID     = process.env.SCHWAB_CLIENT_ID;
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET;
const PORT          = 8080;
const REDIRECT_URI  = `https://127.0.0.1:${PORT}/api/auth/schwab/callback`;
const AUTH_URL      = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL     = 'https://api.schwabapi.com/v1/oauth/token';
const API_BASE      = 'https://api.schwabapi.com/trader/v1';

const DATA_DIR   = path.join(__dirname, 'data');
const CERTS_DIR  = path.join(__dirname, 'certs');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');
const HASH_FILE  = path.join(DATA_DIR, 'account-hash.json');
const CSV_FILE   = path.join(DATA_DIR, 'schwab-import.csv');

[DATA_DIR, CERTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// ── SSL cert (self-signed, generated once) ──────────────────────────────────
const CERT_FILE = path.join(CERTS_DIR, 'cert.pem');
const KEY_FILE  = path.join(CERTS_DIR, 'key.pem');
if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
  console.log('Generating self-signed SSL cert...');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
    `-days 825 -nodes -subj "/CN=127.0.0.1"`,
    { stdio: 'ignore' }
  );
}
const sslOptions = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };

// ── Token helpers ────────────────────────────────────────────────────────────
function loadTokens() {
  return fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : null;
}
function saveTokens(t) {
  t.saved_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}
function isTokenValid(tokens) {
  if (!tokens) return false;
  const age = Date.now() - new Date(tokens.saved_at).getTime();
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
  if (!tokens) throw new Error('Not authenticated — visit /auth first');
  if (!isTokenValid(tokens)) tokens = await refreshToken(tokens);
  return tokens.access_token;
}

// ── Account hash ─────────────────────────────────────────────────────────────
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

// ── Transaction converter ────────────────────────────────────────────────────
function toMMDDYYYY(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;
}
function toOptionSymbol(inst) {
  const expiry = toMMDDYYYY(inst.expirationDate);
  const strike = parseFloat(inst.strikePrice).toFixed(2);
  const type   = inst.putCall === 'PUT' ? 'P' : 'C';
  return `${inst.underlyingSymbol} ${expiry} ${strike} ${type}`;
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
  const fees = (t.transferItems || [])
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
  };
}
function writeCSV(rows) {
  const headers = ['Date','Action','Symbol','Description','Quantity','Price','Fees & Comm','Amount','AcctgRuleCd'];
  const lines   = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => {
      const v = String(row[h] ?? '');
      return v.includes(',') ? `"${v}"` : v;
    }).join(','));
  }
  fs.writeFileSync(CSV_FILE, lines.join('\n'), 'utf8');
  return rows.length;
}

// ── Sync status — persisted to disk so restarts don't lose last-run info ──────
const STATUS_FILE = path.join(DATA_DIR, 'sync-status.json');
function loadSyncStatus() {
  try { return fs.existsSync(STATUS_FILE) ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) : {}; } catch { return {}; }
}
function saveSyncStatus(s) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2));
}
let syncStatus = { running: false, ...loadSyncStatus() };

async function runSync(days = 90) {
  syncStatus.running = true;
  try {
    const token = await getAccessToken();
    const acct  = await getAccountHash(token);
    const end   = new Date();
    const start = new Date(Date.now() - days * 86400000);
    const params = (type) => new URLSearchParams({ startDate: start.toISOString(), endDate: end.toISOString(), types: type });

    const [trades, deliveries] = await Promise.all([
      fetch(`${API_BASE}/accounts/${acct.hash}/transactions?${params('TRADE')}`,              { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()),
      fetch(`${API_BASE}/accounts/${acct.hash}/transactions?${params('RECEIVE_AND_DELIVER')}`, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()),
    ]);

    const rows  = [...trades, ...deliveries].map(convertTxn).filter(Boolean);
    const count = writeCSV(rows);

    const actionCounts = {};
    for (const r of rows) actionCounts[r.Action] = (actionCounts[r.Action] || 0) + 1;

    syncStatus = { running: false, lastRun: new Date().toISOString(), lastCount: count, lastError: null, actionCounts, days, account: acct.accountNumber };
    saveSyncStatus(syncStatus);
    return syncStatus;
  } catch (err) {
    syncStatus = { running: false, lastRun: new Date().toISOString(), lastCount: null, lastError: err.message };
    saveSyncStatus(syncStatus);
    throw err;
  }
}

// ── CSV parser (for recent trades panel) ─────────────────────────────────────
function parseCSVFile(filePath, limit = 30) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).slice(-limit).reverse().map(line => {
    const cells = [];
    let cur = '', inQ = false;
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

// ── Express app ──────────────────────────────────────────────────────────────
const app    = express();
const states = new Map();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── API: sync status (polled by dashboard) ───────────────────────────────────
app.get('/api/status', (req, res) => {
  const tokens  = loadTokens();
  const hasData = fs.existsSync(CSV_FILE);
  const csvSize = hasData ? (fs.statSync(CSV_FILE).size / 1024).toFixed(1) + ' KB' : null;
  res.json({ ...syncStatus, authed: isTokenValid(tokens), hasData, csvSize });
});

// ── API: live open positions from Schwab ─────────────────────────────────────
app.get('/api/positions', async (req, res) => {
  try {
    const token = await getAccessToken();
    const acct  = await getAccountHash(token);
    const r     = await fetch(`${API_BASE}/accounts/${acct.hash}?fields=positions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data  = await r.json();
    if (!r.ok) return res.status(500).json({ error: JSON.stringify(data) });
    const positions = (data.securitiesAccount?.positions || []).map(p => ({
      symbol:      p.instrument?.symbol || '—',
      description: p.instrument?.description || '',
      assetType:   p.instrument?.assetType || '',
      putCall:     p.instrument?.putCall || null,
      underlying:  p.instrument?.underlyingSymbol || null,
      longQty:     p.longQuantity  || 0,
      shortQty:    p.shortQuantity || 0,
      avgPrice:    p.averagePrice  || p.averageShortPrice || 0,
      marketValue: p.marketValue   || 0,
      dayPnl:      p.currentDayProfitLoss || 0,
      openPnl:     (p.longOpenProfitLoss || 0) + (p.shortOpenProfitLoss || 0),
    }));
    res.json(positions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: recent transactions from CSV ────────────────────────────────────────
app.get('/api/recent', (req, res) => {
  const limit = parseInt(req.query.limit || '25', 10);
  res.json(parseCSVFile(CSV_FILE, limit));
});

// ── API: trigger sync ────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  if (syncStatus.running) return res.json({ ok: false, reason: 'already running' });
  const days = parseInt(req.body?.days || '90', 10);
  runSync(days).catch(() => {});
  res.json({ ok: true, days });
});

// ── OAuth: start ──────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'readonly');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// ── OAuth: callback ───────────────────────────────────────────────────────────
app.get('/api/auth/schwab/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  if (!states.has(state)) return res.redirect('/?error=invalid_state');
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
    res.redirect('/');
  } catch (err) {
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

// ── Download CSV ──────────────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  if (!fs.existsSync(CSV_FILE)) return res.status(404).send('No CSV yet.');
  res.download(CSV_FILE, 'schwab-import.csv');
});

// ── Dashboard (full-page SPA) ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TG-Capital Local</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg0: #0f1117; --bg1: #1a1d27; --bg2: #22253a; --bg3: #2a2d3a;
      --text0: #e8e8ec; --text1: #b0b3c0; --text2: #6b7280;
      --green: #4caf50; --red: #f44336; --amber: #f59e0b; --blue: #3b82f6;
      --green-dim: #1f2c1f; --red-dim: #2c1f1f; --blue-dim: #1e2d4a;
      --mono: 'SF Mono', 'Fira Code', monospace;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg0); color: var(--text0); min-height: 100vh; }

    /* ── Layout ── */
    header { display: flex; align-items: center; justify-content: space-between; padding: 16px 28px; border-bottom: 1px solid var(--bg3); background: var(--bg1); }
    .logo { font-size: 16px; font-weight: 700; letter-spacing: -.3px; }
    .logo span { color: var(--blue); }
    .header-right { display: flex; align-items: center; gap: 12px; font-size: 13px; }
    main { padding: 24px 28px; max-width: 1400px; margin: 0 auto; }

    /* ── KPI row ── */
    .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kpi { background: var(--bg1); border: 1px solid var(--bg3); border-radius: 10px; padding: 14px 16px; }
    .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--text2); margin-bottom: 6px; }
    .kpi-val { font-size: 22px; font-weight: 700; font-family: var(--mono); }
    .kpi-sub { font-size: 11px; color: var(--text2); margin-top: 2px; }

    /* ── Panels ── */
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }
    .panel { background: var(--bg1); border: 1px solid var(--bg3); border-radius: 10px; overflow: hidden; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--bg3); }
    .panel-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text1); }
    .panel-body { overflow-x: auto; }

    /* ── Tables ── */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { padding: 9px 14px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text2); border-bottom: 1px solid var(--bg3); white-space: nowrap; }
    td { padding: 9px 14px; border-bottom: 1px solid var(--bg2); white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg2); }
    .r { text-align: right; }
    .mono { font-family: var(--mono); font-size: 12px; }

    /* ── Badges ── */
    .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .b-sto  { background: #1a2e1a; color: var(--green); }
    .b-btc  { background: #2c1f1f; color: var(--red); }
    .b-bto  { background: #1f2333; color: #7dd3fc; }
    .b-stc  { background: #2a2010; color: var(--amber); }
    .b-exp  { background: var(--bg3); color: var(--text2); }
    .b-buy  { background: #1a2e1a; color: var(--green); }
    .b-sell { background: #2c1f1f; color: var(--red); }
    .b-opt  { background: #1e2d4a; color: #93c5fd; }
    .b-eq   { background: var(--bg3); color: var(--text1); }
    .g { color: var(--green); } .r2 { color: var(--red); } .dim { color: var(--text2); }

    /* ── Buttons ── */
    button { cursor: pointer; border: none; font-size: 13px; font-weight: 600; border-radius: 7px; padding: 8px 16px; transition: opacity .15s; }
    button:hover { opacity: .85; }
    .btn-primary { background: var(--blue); color: #fff; }
    .btn-sm { background: var(--bg3); color: var(--text0); font-size: 12px; padding: 5px 12px; }
    .btn-link { background: none; color: var(--text2); font-size: 12px; padding: 5px 8px; }
    .btn-link:hover { color: var(--text0); }

    /* ── Auth wall ── */
    .auth-wall { display: flex; align-items: center; justify-content: center; min-height: 60vh; }
    .auth-card { background: var(--bg1); border: 1px solid var(--bg3); border-radius: 12px; padding: 40px; text-align: center; max-width: 360px; }
    .auth-card h2 { margin-bottom: 10px; }
    .auth-card p { color: var(--text2); font-size: 14px; margin-bottom: 24px; }

    /* ── Spinner ── */
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--bg3); border-top-color: var(--blue); border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Sync bar ── */
    .sync-bar { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text1); }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .dot-green { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .dot-red   { background: var(--red); }
    .dot-amber { background: var(--amber); animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }

    /* ── Empty state ── */
    .empty { padding: 32px; text-align: center; color: var(--text2); font-size: 13px; }
  </style>
</head>
<body>

<header>
  <div class="logo">TG<span>·</span>Capital <span style="color:var(--text2);font-weight:400;font-size:13px">Local</span></div>
  <div class="header-right" id="hdr-status">
    <span style="color:var(--text2)">Loading…</span>
  </div>
</header>

<main id="main-content">
  <div style="padding:60px;text-align:center;color:var(--text2)">Loading…</div>
</main>

<script>
const $ = id => document.getElementById(id);
let pollTimer = null;

// ── Badge helper ─────────────────────────────────────────────────────────────
function actionBadge(action) {
  const map = {
    'Sell to Open': ['b-sto','STO'], 'Buy to Close': ['b-btc','BTC'],
    'Buy to Open':  ['b-bto','BTO'], 'Sell to Close': ['b-stc','STC'],
    'Expired': ['b-exp','EXP'], 'Assigned': ['b-stc','ASGN'],
    'Exercised': ['b-sto','EXER'], 'Buy': ['b-buy','BUY'], 'Sell': ['b-sell','SELL'],
  };
  const [cls, label] = map[action] || ['b-exp', action];
  return \`<span class="badge \${cls}">\${label}</span>\`;
}
function fmt$(n) {
  n = parseFloat(n);
  if (isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  return (n < 0 ? '-$' : '$') + abs;
}
function fmtPnl(n) {
  const s = fmt$(n);
  return \`<span class="\${n >= 0 ? 'g' : 'r2'}">\${n >= 0 ? '+' : ''}\${s}</span>\`;
}
function truncSym(s, max=28) { return s.length > max ? s.slice(0,max)+'…' : s; }

// ── Render dashboard when authenticated ──────────────────────────────────────
async function renderDashboard(status) {
  const main = $('main-content');

  // KPIs from sync status
  const ac = status.actionCounts || {};
  const kpis = [
    { label: 'Synced rows', val: status.lastCount ?? '—', sub: status.days ? 'last '+status.days+'d' : '' },
    { label: 'Sell to Open', val: ac['Sell to Open'] ?? '—', sub: 'options sold' },
    { label: 'Buy to Close', val: ac['Buy to Close'] ?? '—', sub: 'closed' },
    { label: 'Expired', val: ac['Expired'] ?? '—', sub: 'worthless' },
    { label: 'Buy / Sell', val: ((ac['Buy']||0) + (ac['Sell']||0)) || '—', sub: 'equity' },
    { label: 'CSV size', val: status.csvSize || '—', sub: '' },
  ];

  const kpiHTML = kpis.map(k => \`
    <div class="kpi">
      <div class="kpi-label">\${k.label}</div>
      <div class="kpi-val mono">\${k.val}</div>
      \${k.sub ? \`<div class="kpi-sub">\${k.sub}</div>\` : ''}
    </div>\`).join('');

  main.innerHTML = \`
    <div class="kpis">\${kpiHTML}</div>
    <div class="panels">
      <div class="panel" id="panel-positions">
        <div class="panel-header">
          <span class="panel-title">Open Positions <span class="dim" style="font-size:11px">(live)</span></span>
          <button class="btn-sm" onclick="loadPositions()">Refresh</button>
        </div>
        <div class="panel-body" id="positions-body">
          <div class="empty">Loading positions…</div>
        </div>
      </div>
      <div class="panel" id="panel-recent">
        <div class="panel-header">
          <span class="panel-title">Recent Transactions</span>
          <span class="dim" style="font-size:11px">last sync</span>
        </div>
        <div class="panel-body" id="recent-body">
          <div class="empty">Loading…</div>
        </div>
      </div>
    </div>
  \`;

  loadPositions();
  loadRecent();
}

async function loadPositions() {
  const el = $('positions-body');
  if (!el) return;
  try {
    const data = await fetch('/api/positions').then(r => r.json());
    if (data.error) { el.innerHTML = \`<div class="empty r2">\${data.error}</div>\`; return; }
    if (!data.length) { el.innerHTML = '<div class="empty">No open positions</div>'; return; }

    const rows = data.map(p => {
      const isOpt  = p.assetType === 'OPTION';
      const qty    = p.shortQty ? \`-\${p.shortQty}\` : \`+\${p.longQty}\`;
      const sym    = isOpt ? truncSym(p.symbol) : p.symbol;
      const typBadge = isOpt
        ? \`<span class="badge b-opt">\${p.putCall === 'PUT' ? 'PUT' : 'CALL'}</span>\`
        : \`<span class="badge b-eq">STOCK</span>\`;
      const mv    = fmt$(p.marketValue);
      const pnl   = fmtPnl(p.openPnl);
      const dayPnl = fmtPnl(p.dayPnl);
      const under = isOpt ? \`<div class="dim" style="font-size:11px">\${p.underlying || ''}</div>\` : '';
      return \`<tr>
        <td>\${typBadge}</td>
        <td><span class="mono" style="font-size:12px">\${sym}</span>\${under}</td>
        <td class="r mono">\${qty}</td>
        <td class="r mono">\${fmt$(p.avgPrice)}</td>
        <td class="r mono">\${mv}</td>
        <td class="r">\${pnl}</td>
        <td class="r">\${dayPnl}</td>
      </tr>\`;
    }).join('');

    el.innerHTML = \`<table>
      <thead><tr>
        <th>Type</th><th>Symbol</th><th class="r">Qty</th>
        <th class="r">Avg Price</th><th class="r">Mkt Value</th>
        <th class="r">Open P&L</th><th class="r">Day P&L</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  } catch(e) {
    el.innerHTML = \`<div class="empty r2">\${e.message}</div>\`;
  }
}

async function loadRecent() {
  const el = $('recent-body');
  if (!el) return;
  try {
    const data = await fetch('/api/recent?limit=25').then(r => r.json());
    if (!data.length) { el.innerHTML = '<div class="empty">No transactions — run a sync first</div>'; return; }
    const rows = data.map(r => \`<tr>
      <td class="dim mono" style="font-size:11px">\${r.Date || '—'}</td>
      <td>\${actionBadge(r.Action)}</td>
      <td class="mono" style="font-size:11px">\${truncSym(r.Symbol,24)}</td>
      <td class="r mono">\${r.Quantity || '—'}</td>
      <td class="r mono">\${r.Price ? '$'+parseFloat(r.Price).toFixed(2) : '—'}</td>
      <td class="r mono \${parseFloat(r.Amount)>=0?'g':'r2'}">\${fmt$(r.Amount)}</td>
    </tr>\`).join('');
    el.innerHTML = \`<table>
      <thead><tr><th>Date</th><th>Action</th><th>Symbol</th>
        <th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  } catch(e) {
    el.innerHTML = \`<div class="empty r2">\${e.message}</div>\`;
  }
}

// ── Render auth wall ─────────────────────────────────────────────────────────
function renderAuthWall() {
  $('main-content').innerHTML = \`
    <div class="auth-wall">
      <div class="auth-card">
        <h2>Connect Schwab</h2>
        <p>Authenticate with your Charles Schwab account to start syncing transactions.</p>
        <a href="/auth"><button class="btn-primary" style="width:100%;padding:12px">Connect Schwab Account</button></a>
      </div>
    </div>\`;
}

// ── Header status bar ────────────────────────────────────────────────────────
function updateHeader(status) {
  const hdr = $('hdr-status');
  const lastSync = status.lastRun ? new Date(status.lastRun).toLocaleTimeString() : 'Never';
  const acct = status.account ? \`<span class="mono" style="color:var(--text2);font-size:12px">Acct \${status.account}</span>\` : '';
  let syncBtn = '';
  if (status.running) {
    syncBtn = \`<span><span class="dot dot-amber"></span> Syncing…</span>\`;
  } else if (status.authed) {
    syncBtn = \`
      <button class="btn-sm" onclick="triggerSync(90)">Sync 90d</button>
      <button class="btn-sm" onclick="triggerSync(365)">Sync 12mo</button>
      \${status.hasData ? '<a href="/download"><button class="btn-sm">Download CSV</button></a>' : ''}
      <a href="/auth"><button class="btn-link">Re-auth</button></a>\`;
  }
  const statusDot = status.authed
    ? \`<span class="dot dot-green"></span> <span style="color:var(--green);font-size:12px">Connected</span>\`
    : \`<span class="dot dot-red"></span> <span style="color:var(--red);font-size:12px">Not connected</span>\`;
  const lastSyncStr = status.lastRun
    ? \`<span style="color:var(--text2);font-size:12px">Last sync \${lastSync}</span>\`
    : '';

  hdr.innerHTML = \`\${acct} \${statusDot} \${lastSyncStr} \${syncBtn}\`;
}

async function triggerSync(days) {
  await fetch('/api/sync', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({days}) });
  poll();
}

// ── Main poll loop ────────────────────────────────────────────────────────────
let lastRunning = false;
let dashRendered = false;

async function poll() {
  try {
    const status = await fetch('/api/status').then(r => r.json());
    updateHeader(status);

    if (!status.authed) {
      renderAuthWall();
      dashRendered = false;
    } else if (!dashRendered || (lastRunning && !status.running)) {
      await renderDashboard(status);
      dashRendered = true;
    }

    lastRunning = status.running;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, status.running ? 1500 : 30000);
  } catch(e) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 5000);
  }
}

poll();
</script>
</body>
</html>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = https.createServer(sslOptions, app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  TG-Capital Local running at https://127.0.0.1:${PORT}\n`);
  console.log(`   If not authenticated, visit https://127.0.0.1:${PORT}/auth`);
  console.log(`   Type "thisisunsafe" in Edge if you see a cert warning.\n`);
});
