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

// ── Express app ──────────────────────────────────────────────────────────────
const app    = express();
const states = new Map(); // OAuth state → timestamp

app.use(express.urlencoded({ extended: false }));

// Status dashboard
app.get('/', (req, res) => {
  const tokens    = loadTokens();
  const authed    = isTokenValid(tokens);
  const hasData   = fs.existsSync(CSV_FILE);
  const csvSize   = hasData ? (fs.statSync(CSV_FILE).size / 1024).toFixed(1) + ' KB' : '—';
  const lastSync  = syncStatus.lastRun ? new Date(syncStatus.lastRun).toLocaleString() : 'Never';
  const authColor = authed ? '#4caf50' : '#f44336';
  const authLabel = authed ? '✅ Authenticated' : '❌ Not authenticated';

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TG-Capital Local</title>
  ${syncStatus.running ? '<meta http-equiv="refresh" content="2">' : ''}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0f1117; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 12px; padding: 32px; width: 420px; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
    .sub { font-size: 13px; color: #888; margin-bottom: 28px; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #2a2d3a; font-size: 14px; }
    .row:last-of-type { border-bottom: none; }
    .label { color: #888; }
    .val { font-weight: 500; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .green { background: #1f2c1f; color: #4caf50; }
    .red   { background: #2c1f1f; color: #f44336; }
    .actions { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
    button, a.btn { display: block; width: 100%; padding: 11px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; text-align: center; text-decoration: none; }
    .primary { background: #2563eb; color: #fff; }
    .primary:hover { background: #1d4ed8; }
    .secondary { background: #2a2d3a; color: #e0e0e0; }
    .secondary:hover { background: #333648; }
    .error { margin-top: 12px; padding: 10px; background: #2c1f1f; border-radius: 8px; font-size: 13px; color: #f44336; }
    .counts { margin-top: 16px; font-size: 12px; color: #888; }
    .counts span { color: #e0e0e0; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>TG-Capital Local</h1>
    <p class="sub">Schwab API → CSV auto-sync</p>

    <div class="row"><span class="label">Status</span>
      <span class="badge ${authed ? 'green' : 'red'}">${authLabel}</span>
    </div>
    <div class="row"><span class="label">Account</span>
      <span class="val">${syncStatus.account || (tokens?.account_number || '—')}</span>
    </div>
    <div class="row"><span class="label">Last sync</span>
      <span class="val">${lastSync}</span>
    </div>
    <div class="row"><span class="label">Rows generated</span>
      <span class="val">${syncStatus.lastCount ?? '—'}</span>
    </div>
    <div class="row"><span class="label">CSV size</span>
      <span class="val">${csvSize}</span>
    </div>

    ${syncStatus.actionCounts ? `
    <div class="counts">
      ${Object.entries(syncStatus.actionCounts).map(([a,c]) => `<div><span>${c}</span>  ${a}</div>`).join('')}
    </div>` : ''}

    ${syncStatus.lastError ? `<div class="error">Error: ${syncStatus.lastError}</div>` : ''}

    <div class="actions">
      ${!authed
        ? `<a class="btn primary" href="/auth">Connect Schwab Account</a>`
        : `
        <form method="POST" action="/sync">
          <button class="primary" type="submit">${syncStatus.running ? 'Syncing…' : '🔄 Sync Now (last 90 days)'}</button>
        </form>
        <form method="POST" action="/sync">
          <input type="hidden" name="days" value="365">
          <button class="secondary" type="submit">Sync last 12 months</button>
        </form>
        ${hasData ? `<a class="btn secondary" href="/download">⬇️  Download CSV</a>` : ''}
        <a class="btn secondary" href="/auth">Re-authenticate</a>
        `}
    </div>
  </div>
</body>
</html>`);
});

// Start OAuth
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

// OAuth callback
app.get('/api/auth/schwab/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  if (!states.has(state)) return res.redirect('/?error=invalid_state');
  states.delete(state);

  try {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const r     = await fetch(TOKEN_URL, {
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

// Trigger sync
app.post('/sync', async (req, res) => {
  if (syncStatus.running) return res.redirect('/');
  const days = parseInt(req.body?.days || '90', 10);
  runSync(days).catch(() => {});
  res.redirect('/');
});

// Download CSV
app.get('/download', (req, res) => {
  if (!fs.existsSync(CSV_FILE)) return res.status(404).send('No CSV yet — run a sync first.');
  res.download(CSV_FILE, 'schwab-import.csv');
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = https.createServer(sslOptions, app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  TG-Capital Local running at https://127.0.0.1:${PORT}\n`);
  console.log(`   If not authenticated, visit https://127.0.0.1:${PORT}/auth`);
  console.log(`   Type "thisisunsafe" in Edge if you see a cert warning.\n`);
});
