#!/usr/bin/env node
/**
 * TG-Capital Local — Setup Checker
 * Run this BEFORE docker compose up to verify everything is in place.
 *
 *   node setup-check.js
 *
 * What it checks:
 *   1. .env file exists and has Schwab credentials
 *   2. Schwab callback URL is configured correctly in your Developer Portal
 *   3. Docker is installed and running
 *   4. Ollama is reachable and required models are pulled
 *   5. Required ports are free
 */

'use strict';
require('dotenv').config();
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const http         = require('http');

const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✘\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const INFO = '\x1b[36mℹ\x1b[0m';

let allGood = true;

function ok(msg)   { console.log(`  ${PASS}  ${msg}`); }
function fail(msg) { console.log(`  ${FAIL}  ${msg}`); allGood = false; }
function warn(msg) { console.log(`  ${WARN}  ${msg}`); }
function info(msg) { console.log(`  ${INFO}  ${msg}`); }

// ── 1. .env ───────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[1] Environment (.env)\x1b[0m');

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  fail('.env file not found — copy .env.example to .env and fill in your credentials');
  fail('  cp .env.example .env');
} else {
  ok('.env file found');

  const id     = process.env.SCHWAB_CLIENT_ID;
  const secret = process.env.SCHWAB_CLIENT_SECRET;

  if (!id || id.includes('YOUR_') || id === 'your_client_id_here') {
    fail('SCHWAB_CLIENT_ID is not set — get it from https://developer.schwab.com');
  } else {
    ok(`SCHWAB_CLIENT_ID set (${id.slice(0,6)}…${id.slice(-4)})`);
  }

  if (!secret || secret.includes('YOUR_') || secret === 'your_client_secret_here') {
    fail('SCHWAB_CLIENT_SECRET is not set — get it from https://developer.schwab.com');
  } else {
    ok(`SCHWAB_CLIENT_SECRET set (${secret.slice(0,4)}…${secret.slice(-4)})`);
  }

  const chatModel  = process.env.CHAT_MODEL  || '0xroyce/plutus';
  const embedModel = process.env.EMBED_MODEL;
  info(`CHAT_MODEL  = ${chatModel}`);
  info(`EMBED_MODEL = ${embedModel || '(auto-detect from Ollama)'}`);
}

// ── 2. Schwab Developer Portal reminder ──────────────────────────────────────
console.log('\n\x1b[1m[2] Schwab Developer Portal\x1b[0m');
console.log('    Your Schwab app at https://developer.schwab.com must have this');
console.log('    exact Callback URL registered:');
console.log('\n      \x1b[1;33mhttps://127.0.0.1:8080/api/auth/schwab/callback\x1b[0m\n');
warn('Cannot verify this automatically — confirm it in your Schwab app settings');

// ── 3. Docker ─────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[3] Docker\x1b[0m');
try {
  const ver = execSync('docker --version', { stdio: 'pipe' }).toString().trim();
  ok(ver);
} catch {
  fail('Docker not found — install from https://docs.docker.com/get-docker/');
}
try {
  execSync('docker info', { stdio: 'pipe' });
  ok('Docker daemon is running');
} catch {
  fail('Docker daemon is not running — start Docker Desktop or run: sudo systemctl start docker');
}
try {
  const cv = execSync('docker compose version', { stdio: 'pipe' }).toString().trim();
  ok(cv);
} catch {
  fail('docker compose not found — update Docker or install the compose plugin');
}

// ── 4. Ollama ─────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m[4] Ollama\x1b[0m');

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

async function checkOllama() {
  return new Promise(resolve => {
    const url  = new URL(OLLAMA + '/api/tags');
    const opts = { hostname: url.hostname, port: url.port || 11434, path: url.pathname, timeout: 4000 };
    const req  = http.get(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const { models = [] } = JSON.parse(body);
          const names = models.map(m => m.name);
          ok(`Ollama reachable at ${OLLAMA} — ${names.length} model(s) found`);

          const REQUIRED_CHAT  = process.env.CHAT_MODEL  || '0xroyce/plutus';
          const REQUIRED_EMBED = process.env.EMBED_MODEL || null;
          const EMBED_DEFAULTS = ['mxbai-embed-large', 'nomic-embed-text', 'qwen3-embedding'];

          const hasChat = names.some(n => n.startsWith(REQUIRED_CHAT.split(':')[0]));
          if (hasChat) ok(`Chat model found: ${REQUIRED_CHAT}`);
          else         fail(`Chat model NOT found: ${REQUIRED_CHAT}\n      Fix: ollama pull ${REQUIRED_CHAT}`);

          if (REQUIRED_EMBED) {
            const hasEmbed = names.some(n => n.startsWith(REQUIRED_EMBED.split(':')[0]));
            if (hasEmbed) ok(`Embed model found: ${REQUIRED_EMBED}`);
            else          fail(`Embed model NOT found: ${REQUIRED_EMBED}\n      Fix: ollama pull ${REQUIRED_EMBED}`);
          } else {
            const found = EMBED_DEFAULTS.find(e => names.some(n => n.startsWith(e)));
            if (found) ok(`Embed model auto-detected: ${found}`);
            else       warn(`No embedding model found — RAG/AI search will use keyword fallback\n      Fix: ollama pull mxbai-embed-large`);
          }
          resolve();
        } catch { fail('Ollama responded but returned unexpected data'); resolve(); }
      });
    });
    req.on('error', () => {
      fail(`Ollama not reachable at ${OLLAMA}`);
      info('Start Ollama:  ollama serve');
      info('Or install:    https://ollama.com/download');
      resolve();
    });
    req.on('timeout', () => { req.destroy(); fail(`Ollama timed out at ${OLLAMA}`); resolve(); });
  });
}

// ── 5. Port 8080 ──────────────────────────────────────────────────────────────
function checkPort() {
  console.log('\n\x1b[1m[5] Port 8080\x1b[0m');
  return new Promise(resolve => {
    const srv = require('net').createServer();
    srv.once('error', err => {
      if (err.code === 'EADDRINUSE') warn('Port 8080 is already in use — stop the existing process or change the port');
      else                           warn(`Port check failed: ${err.message}`);
      resolve();
    });
    srv.once('listening', () => { ok('Port 8080 is free'); srv.close(resolve); });
    srv.listen(8080, '0.0.0.0');
  });
}

// ── Run all checks ────────────────────────────────────────────────────────────
(async () => {
  await checkOllama();
  await checkPort();

  console.log('\n' + '─'.repeat(60));
  if (allGood) {
    console.log('\x1b[32m\x1b[1m  All checks passed — ready to launch!\x1b[0m');
    console.log('\n  Start the app:');
    console.log('    docker compose up -d\n');
    console.log('  Then open:  https://127.0.0.1:8080');
    console.log('  Authorize:  https://127.0.0.1:8080/auth  (first time only)\n');
  } else {
    console.log('\x1b[31m\x1b[1m  Some checks failed — fix the issues above before starting.\x1b[0m\n');
    process.exit(1);
  }
})();
