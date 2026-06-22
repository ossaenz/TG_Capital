/**
 * TG-Capital Local Server
 * Serves a cloned copy of the main app (in /app/webapp/) with Schwab
 * auto-sync injected at runtime. Original source files are never modified.
 *
 * Routes:
 *   GET  /*                         → cloned webapp (index.html gets script injected)
 *   GET  /auth                      → start Schwab OAuth
 *   GET  /api/auth/schwab/callback  → OAuth callback (redirects back to /)
 *   GET  /api/status                → sync status JSON
 *   POST /api/sync                  → trigger Schwab transaction pull
 *   GET  /api/csv-text              → raw CSV text for in-app auto-import
 *   GET  /api/positions             → live positions from Schwab API
 *   GET  /api/recent                → recent rows from last generated CSV
 *   GET  /local-enhance.js          → enhancement script served to webapp
 *   GET  /download                  → download generated CSV file
 */

require('dotenv').config();
const express        = require('express');
const https          = require('https');
const fetch          = require('node-fetch');
const fs             = require('fs');
const path           = require('path');
const crypto         = require('crypto');
const { execSync }   = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.SCHWAB_CLIENT_ID;
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET;
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

[DATA_DIR, CERTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// ── SSL (self-signed, generated once into the certs volume) ──────────────────
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

// ── Account hash (cached) ─────────────────────────────────────────────────────
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

// ── Transaction converter (Schwab API → CSV row) ──────────────────────────────
function toMMDDYYYY(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;
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

async function runSync(days = 90) {
  syncStatus.running = true;
  try {
    const token = await getAccessToken();
    const acct  = await getAccountHash(token);
    const end   = new Date();
    const start = new Date(Date.now() - days * 86400000);
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

    const actionCounts = {};
    for (const r of rows) actionCounts[r.Action] = (actionCounts[r.Action] || 0) + 1;

    syncStatus = { running: false, lastRun: new Date().toISOString(), lastCount: rows.length, lastError: null, actionCounts, days, account: acct.accountNumber };
    saveSyncStatus(syncStatus);
    console.log(`✅  Sync complete: ${rows.length} rows (${days}d)`);
  } catch (err) {
    syncStatus = { ...syncStatus, running: false, lastRun: new Date().toISOString(), lastError: err.message };
    saveSyncStatus(syncStatus);
    console.error('❌  Sync failed:', err.message);
  }
}

// ── CSV file parser (for /api/recent) ─────────────────────────────────────────
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
  res.json({ ...syncStatus, authed: isTokenValid(tokens), hasData, csvSize });
});

// ── API: trigger sync ─────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  if (syncStatus.running) return res.json({ ok: false, reason: 'already running' });
  const days = parseInt(req.body?.days || '90', 10);
  runSync(days).catch(() => {});
  res.json({ ok: true, days });
});

// ── API: raw CSV text (for in-app auto-import) ────────────────────────────────
app.get('/api/csv-text', (req, res) => {
  if (!fs.existsSync(CSV_FILE)) return res.status(404).send('No CSV yet');
  res.setHeader('Content-Type', 'text/plain');
  res.send(fs.readFileSync(CSV_FILE, 'utf8'));
});

// ── API: live positions ───────────────────────────────────────────────────────
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
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: recent rows from CSV ─────────────────────────────────────────────────
app.get('/api/recent', (req, res) => {
  res.json(parseCSVFile(parseInt(req.query.limit || '25', 10)));
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
    console.log('✅  Schwab authenticated — account tokens saved');
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

// ── Serve cloned webapp — inject enhancement script into index.html ───────────
app.use(express.static(WEBAPP_DIR));

app.get('/', (req, res) => {
  const indexPath = path.join(WEBAPP_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return res.status(500).send('Webapp not found in container.');
  let html = fs.readFileSync(indexPath, 'utf8');
  // Inject before </body> — adds Schwab sync panel to the Import section
  html = html.replace('</body>', `
  <script src="/local-enhance.js"></script>
</body>`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ── Start ─────────────────────────────────────────────────────────────────────
https.createServer(ssl, app).listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  TG-Capital Local at https://127.0.0.1:${PORT}`);
  console.log(`   Full app served from /app/webapp/ with Schwab sync injected`);
  console.log(`   Type "thisisunsafe" in Edge on cert warning\n`);
});
