/**
 * sync-schwab.js
 * Fetches transactions from the Schwab API and converts them to the same
 * CSV format as a Schwab manual export — so importRecords() in parsing.js
 * can ingest them without any changes to the web app.
 *
 * Usage:
 *   node sync-schwab.js              # last 90 days
 *   node sync-schwab.js --days 365   # last 365 days
 *   node sync-schwab.js --since 2025-01-01
 */

require('dotenv').config();
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const TOKEN_FILE  = path.join(__dirname, '.schwab-tokens.json');
const HASH_FILE   = path.join(__dirname, '.schwab-account-hash.json');
const OUTPUT_CSV  = path.join(__dirname, 'schwab-auto-import.csv');
const TOKEN_URL   = 'https://api.schwabapi.com/v1/oauth/token';
const API_BASE    = 'https://api.schwabapi.com/trader/v1';

// ── Parse CLI args ──────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
let days    = 90;
let since   = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1])  days  = parseInt(args[++i], 10);
  if (args[i] === '--since' && args[i+1]) since = args[++i];
}

// ── Token management ────────────────────────────────────────────────────────
async function getValidToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error('❌  No tokens. Run test-schwab-auth.js first.');
    process.exit(1);
  }
  let tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const age  = Date.now() - new Date(tokens.saved_at).getTime();
  const ttl  = (tokens.expires_in || 1800) * 1000;

  if (age < ttl - 60000) return tokens.access_token;

  console.log('  Refreshing access token...');
  const creds = Buffer.from(
    `${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`
  ).toString('base64');

  const res  = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
  });
  const next = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(next)}`);
  next.saved_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(next, null, 2));
  return next.access_token;
}

// ── Get (or cache) account hash ─────────────────────────────────────────────
async function getAccountHash(token) {
  if (fs.existsSync(HASH_FILE)) {
    return JSON.parse(fs.readFileSync(HASH_FILE, 'utf8')).hash;
  }
  const res  = await fetch(`${API_BASE}/accounts/accountNumbers`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok || !data.length) throw new Error('Could not fetch account numbers');
  const { accountNumber, hashValue } = data[0];
  fs.writeFileSync(HASH_FILE, JSON.stringify({ accountNumber, hash: hashValue }, null, 2));
  console.log(`  Account: ${accountNumber}`);
  return hashValue;
}

// ── Convert Schwab API date → MM/DD/YYYY ────────────────────────────────────
function toMMDDYYYY(isoStr) {
  const d = new Date(isoStr);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = d.getUTCFullYear();
  return `${mm}/${dd}/${yy}`;
}

// ── Convert Schwab option symbol → our "AAPL 01/19/2024 150.00 C" format ───
function toOptionSymbol(inst) {
  if (inst.assetType !== 'OPTION') return null;
  const underlying = inst.underlyingSymbol;
  const expiry     = toMMDDYYYY(inst.expirationDate);
  const strike     = parseFloat(inst.strikePrice).toFixed(2);
  const type       = inst.putCall === 'PUT' ? 'P' : 'C';
  return `${underlying} ${expiry} ${strike} ${type}`;
}

// ── Derive Schwab-style action from API fields ───────────────────────────────
function toAction(inst, positionEffect, amount, txnType, description) {
  const desc = (description || '').toLowerCase();

  if (txnType === 'RECEIVE_AND_DELIVER') {
    if (inst.assetType === 'OPTION') {
      if (desc.includes('expir'))    return 'Expired';
      if (desc.includes('assigned')) return 'Assigned';
      if (desc.includes('exercis'))  return 'Exercised';
    }
    return null; // skip other RECEIVE_AND_DELIVER (stock deliveries for assigned options)
  }

  if (inst.assetType === 'OPTION') {
    const sold = amount < 0;
    if (positionEffect === 'OPENING') return sold ? 'Sell to Open'  : 'Buy to Open';
    if (positionEffect === 'CLOSING') return sold ? 'Sell to Close' : 'Buy to Close';
    return null;
  }
  if (inst.assetType === 'EQUITY') {
    return amount > 0 ? 'Buy' : 'Sell';
  }
  return null;
}

// ── Convert one Schwab API transaction → CSV row object ─────────────────────
function convertTransaction(t) {
  // Find the primary instrument (non-currency) leg
  const legs = (t.transferItems || []).filter(
    i => i.instrument && i.instrument.assetType !== 'CURRENCY'
  );
  if (!legs.length) return null;

  // Total fees = sum of all CURRENCY leg amounts
  const fees = (t.transferItems || [])
    .filter(i => i.instrument && i.instrument.assetType === 'CURRENCY' && i.feeType)
    .reduce((sum, i) => sum + Math.abs(i.amount || 0), 0);

  // Use the first non-currency leg (multi-leg orders handled as separate API records)
  const leg    = legs[0];
  const inst   = leg.instrument;
  const action = toAction(inst, leg.positionEffect, leg.amount, t.type, t.description);
  if (!action) return null;

  const symbol = inst.assetType === 'OPTION'
    ? toOptionSymbol(inst)
    : inst.symbol;

  if (!symbol) return null;

  const date = toMMDDYYYY(t.settlementDate || t.tradeDate || t.time);
  const qty  = Math.abs(leg.amount || 0);
  // For options: qty is already in contracts; price is per-share (multiply by 100 = contract value)
  const price = leg.price || 0;
  const amt   = t.netAmount || 0;

  return {
    'Date':        date,
    'Action':      action,
    'Symbol':      symbol,
    'Description': inst.description || '',
    'Quantity':    qty.toString(),
    'Price':       price.toFixed(4),
    'Fees & Comm': fees > 0 ? fees.toFixed(2) : '',
    'Amount':      amt.toFixed(2),
    'AcctgRuleCd': '',
    '_activityId': t.activityId,  // for dedup tracking (not in CSV)
  };
}

// ── Write CSV ────────────────────────────────────────────────────────────────
function writeCSV(rows) {
  const headers = ['Date','Action','Symbol','Description','Quantity','Price','Fees & Comm','Amount','AcctgRuleCd'];
  const lines   = [headers.join(',')];
  for (const row of rows) {
    const cells = headers.map(h => {
      const v = row[h] ?? '';
      return String(v).includes(',') ? `"${v}"` : v;
    });
    lines.push(cells.join(','));
  }
  fs.writeFileSync(OUTPUT_CSV, lines.join('\n'), 'utf8');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const token = await getValidToken();
  const hash  = await getAccountHash(token);

  const endDate   = new Date();
  const startDate = since
    ? new Date(since)
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`\n📡  Fetching transactions ${startDate.toISOString().slice(0,10)} → ${endDate.toISOString().slice(0,10)}\n`);

  async function fetchType(type) {
    const params = new URLSearchParams({ startDate: startDate.toISOString(), endDate: endDate.toISOString(), types: type });
    const res    = await fetch(`${API_BASE}/accounts/${hash}/transactions?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`API error (${type}): ${JSON.stringify(body)}`);
    return body;
  }

  const [trades, deliveries] = await Promise.all([
    fetchType('TRADE'),
    fetchType('RECEIVE_AND_DELIVER'),
  ]);
  const data = [...trades, ...deliveries];

  console.log(`  Raw transactions from API: ${data.length}`);

  const rows    = data.map(convertTransaction).filter(Boolean);
  const skipped = data.length - rows.length;

  // Action breakdown
  const counts = {};
  for (const r of rows) counts[r.Action] = (counts[r.Action] || 0) + 1;

  console.log(`  Converted: ${rows.length} rows  (${skipped} skipped — cash/other)\n`);
  console.log('  Actions:');
  for (const [action, count] of Object.entries(counts)) {
    console.log(`    ${count.toString().padStart(4)}×  ${action}`);
  }

  writeCSV(rows);
  console.log(`\n✅  Saved to: ${OUTPUT_CSV}`);
  console.log(`\n  👉  Import this file in the web app:`);
  console.log(`       Settings → Import CSV → select  local/schwab-auto-import.csv\n`);
}

main().catch(err => {
  console.error('\n❌ ', err.message);
  process.exit(1);
});
