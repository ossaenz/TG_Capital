/**
 * Test Schwab transactions endpoint using saved tokens.
 * Fetches last 30 days of transactions and prints the raw structure.
 */

require('dotenv').config();
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

const TOKEN_FILE  = path.join(__dirname, '.schwab-tokens.json');
const API_BASE    = 'https://api.schwabapi.com/trader/v1';
const TOKEN_URL   = 'https://api.schwabapi.com/v1/oauth/token';
const ACCOUNT_NUM = '061326655AD42DFDE7DFB126BD261A963EB5B110E9D1FBC7E686A63B7B91E001';

async function refreshIfNeeded(tokens) {
  const savedAt  = new Date(tokens.saved_at).getTime();
  const expiresMs = (tokens.expires_in || 1800) * 1000;
  const age = Date.now() - savedAt;

  if (age < expiresMs - 60000) {
    console.log(`  access_token still valid (${Math.round((expiresMs - age) / 1000)}s remaining)`);
    return tokens;
  }

  console.log('  access_token expired — refreshing...');
  const credentials = Buffer.from(
    `${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  const next = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(next)}`);

  next.saved_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(next, null, 2));
  console.log('  tokens refreshed and saved');
  return next;
}

async function main() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error('❌  No tokens found. Run test-schwab-auth.js first.');
    process.exit(1);
  }

  let tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  tokens = await refreshIfNeeded(tokens);

  const headers = { 'Authorization': `Bearer ${tokens.access_token}` };

  // ── Fetch last 60 days of transactions ─────────────────────────────────
  const endDate   = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 60);

  const params = new URLSearchParams({
    startDate: startDate.toISOString(),
    endDate:   endDate.toISOString(),
    types:     'TRADE',
  });

  console.log(`\n📡  GET /accounts/${ACCOUNT_NUM}/transactions?${params}\n`);

  const res = await fetch(
    `${API_BASE}/accounts/${ACCOUNT_NUM}/transactions?${params}`,
    { headers }
  );
  const data = await res.json();

  if (!res.ok) {
    console.error('❌  API error:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`✅  Got ${data.length} transactions\n`);

  if (data.length === 0) {
    console.log('No transactions in the last 60 days.');
    return;
  }

  // Print first 3 in full so we can see the schema
  console.log('─── First 3 transactions (raw schema) ───────────────────────\n');
  data.slice(0, 3).forEach((t, i) => {
    console.log(`[${i + 1}]`, JSON.stringify(t, null, 2));
    console.log();
  });

  // Summary of all actions seen
  const actions = {};
  for (const t of data) {
    const key = `${t.type || '?'} / ${t.description || t.transactionItem?.instruction || '?'}`;
    actions[key] = (actions[key] || 0) + 1;
  }
  console.log('─── Action types in this batch ──────────────────────────────\n');
  for (const [k, v] of Object.entries(actions)) {
    console.log(`  ${v.toString().padStart(3)}×  ${k}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
