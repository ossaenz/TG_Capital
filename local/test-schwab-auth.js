/**
 * Schwab API OAuth2 test — confirms your Client ID + Secret work.
 *
 * Steps:
 *   1. node test-schwab-auth.js
 *   2. Browser opens → log in to Schwab → authorize
 *   3. Callback is caught here → exchanges code for token
 *   4. Calls GET /trader/v1/accounts to verify live access
 *   5. Prints result and exits
 *
 * Requires: .env with SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET
 */

require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const open    = require('open');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const CLIENT_ID     = process.env.SCHWAB_CLIENT_ID;
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET;
const REDIRECT_URI  = 'https://127.0.0.1:8080/api/auth/schwab/callback';

const SCHWAB_AUTH_URL  = 'https://api.schwabapi.com/v1/oauth/authorize';
const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const SCHWAB_API_BASE  = 'https://api.schwabapi.com/trader/v1';

if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_ID.startsWith('your_')) {
  console.error('\n❌  Missing credentials. Create local/.env with:\n');
  console.error('    SCHWAB_CLIENT_ID=...');
  console.error('    SCHWAB_CLIENT_SECRET=...\n');
  console.error('Copy local/.env.example to get started.\n');
  process.exit(1);
}

// ── Schwab requires HTTPS even for localhost ──────────────────────────────
// Generate a self-signed cert on the fly (Node built-in, no openssl needed)
function generateSelfSignedCert() {
  const certPath = path.join(__dirname, '.ssl-cert.pem');
  const keyPath  = path.join(__dirname, '.ssl-key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  }

  // Use openssl if available; otherwise inform user
  const { execSync } = require('child_process');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -nodes -subj "/CN=127.0.0.1"`,
      { stdio: 'ignore' }
    );
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch {
    console.error('\n❌  Could not generate SSL cert. Install openssl and retry.\n');
    process.exit(1);
  }
}

async function main() {
  const ssl = generateSelfSignedCert();
  const app = express();
  const state = crypto.randomBytes(16).toString('hex');

  let server;

  // ── Callback endpoint ───────────────────────────────────────────────────
  app.get('/api/auth/schwab/callback', async (req, res) => {
    const { code, state: returnedState, error } = req.query;

    if (error) {
      res.send(`<h2 style="color:red">Auth error: ${error}</h2>`);
      shutdown(1);
      return;
    }
    if (returnedState !== state) {
      res.send('<h2 style="color:red">State mismatch — possible CSRF</h2>');
      shutdown(1);
      return;
    }
    if (!code) {
      res.send('<h2 style="color:red">No code returned</h2>');
      shutdown(1);
      return;
    }

    res.send('<h2>Auth code received — exchanging for token...</h2><p>Check your terminal.</p>');

    try {
      // ── Exchange code for token ─────────────────────────────────────────
      const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
      const tokenRes = await fetch(SCHWAB_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok) {
        console.error('\n❌  Token exchange failed:', JSON.stringify(tokenData, null, 2));
        shutdown(1);
        return;
      }

      console.log('\n✅  Token exchange successful!');
      console.log(`    access_token  : ${tokenData.access_token?.slice(0, 30)}...`);
      console.log(`    refresh_token : ${tokenData.refresh_token?.slice(0, 30)}...`);
      console.log(`    expires_in    : ${tokenData.expires_in}s`);
      console.log(`    token_type    : ${tokenData.token_type}`);

      // ── Test: fetch accounts ────────────────────────────────────────────
      console.log('\n📡  Testing GET /trader/v1/accounts ...');
      const acctRes = await fetch(`${SCHWAB_API_BASE}/accounts`, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
      });
      const acctData = await acctRes.json();

      if (!acctRes.ok) {
        console.error('\n❌  Accounts call failed:', JSON.stringify(acctData, null, 2));
        shutdown(1);
        return;
      }

      console.log(`\n✅  Accounts API call succeeded! Found ${acctData.length} account(s):\n`);
      for (const acct of acctData) {
        const a = acct.securitiesAccount || acct;
        console.log(`    Account: ${a.accountNumber || '?'} (${a.type || '?'})`);
      }

      // Save tokens for future use
      fs.writeFileSync(
        path.join(__dirname, '.schwab-tokens.json'),
        JSON.stringify({ ...tokenData, saved_at: new Date().toISOString() }, null, 2)
      );
      console.log('\n💾  Tokens saved to local/.schwab-tokens.json');
      console.log('    (keep this file private — add to .gitignore)\n');

      shutdown(0);
    } catch (err) {
      console.error('\n❌  Unexpected error:', err.message);
      shutdown(1);
    }
  });

  // ── Start HTTPS server on 8080 ─────────────────────────────────────────
  server = https.createServer(ssl, app);
  server.listen(8080, '127.0.0.1', () => {
    const authUrl = new URL(SCHWAB_AUTH_URL);
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'readonly');
    authUrl.searchParams.set('state', state);

    console.log('\n🚀  Schwab OAuth test started');
    console.log('    Listening on https://127.0.0.1:8080');
    console.log('\n⚠️   Your browser will warn about an untrusted certificate.');
    console.log('    That is expected for localhost. Click "Advanced → Proceed".\n');
    console.log('🔗  Opening Schwab auth page...\n');

    open(authUrl.toString());
  });

  function shutdown(code) {
    server.close(() => process.exit(code));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
