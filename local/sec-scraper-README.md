# Proactive Scout SEC Scraper

Fetches recent SEC filings (8-K, 10-K, 10-Q) for a list of stock tickers and
POSTs them to this app's Proactive Scout ingest endpoint.

No Gmail, Google API, or OAuth dependencies — output goes to
`https://osflex.me/chamuco` (Caddy-proxied to `POST /api/v1/ingest` on this
app — see `local/server.js`) via a Bearer token, nowhere else.

## How it works

1. Resolves each ticker to a CIK via SEC's public `company_tickers.json`.
2. Fetches that company's recent filings via `data.sec.gov/submissions`.
3. Filters to `8-K` / `10-K` / `10-Q` filed within the given date range.
4. Constructs a direct filing URL for each (SEC doesn't return one).
5. POSTs the whole batch as one request to the ingest endpoint above.

## Required secrets (repo Settings → Secrets and variables → Actions)

| Secret | Required | Notes |
|---|---|---|
| `SCOUT_INGEST_TOKEN` | Yes | Bearer token for the ingest endpoint — must match `SCOUT_INGEST_TOKEN` in `local/.env` on the server. Script raises immediately if missing. |
| `SEC_USER_AGENT` | No | SEC asks for an identifying User-Agent with contact info. Defaults to `TG-Capital-ProactiveScout/1.0 contact@osflex.me` if unset. |

## Running

```bash
# from the repo root
python local/sec_scraper.py --tickers TSLA,SPCX,NVDA --start_date 2026-08-01 --end_date 2026-08-11
```

`--tickers` is optional — omitting it uses the default watchlist in
`local/tickers.json`. `--start_date`/`--end_date` are required.

## GitHub Actions

`.github/workflows/sec-scraper.yml` — manual/bulk runs only (`Actions` tab →
`Run workflow`) with a custom comma-separated `tickers` field and your own
date range; leave `tickers` blank to use the default watchlist. The daily
cron is intentionally **disabled** — ongoing filing refresh happens locally
instead (see below), not via GitHub's scheduler.

## Notes

- ETF tickers (e.g. `SPY`) won't return anything under this form filter —
  funds file different forms (`N-PORT`, etc.), not `8-K`/`10-K`/`10-Q`.
- SEC's ticker map only covers companies with SEC filing obligations — a
  ticker not found there is logged and skipped, not treated as an error.

---

# 8-K Discovery, Llama Analysis & Alerts

Builds on the scraper above: periodically re-fetches filings for every
watchlist ticker, runs a local Llama model over each new 8-K to flag
material events, and emails you about them.

## How it works

1. **Discovery loop** (`runDiscoveryLoop()` in `server.js`) — runs once ~60s
   after the server starts, then every 8 hours (~3x/day) thereafter. Reuses
   the exact same fetch mechanism as the "Refresh SEC Filings" button — no
   separate scraper process. Deliberately *not* the continuous/15-minute
   poll you might expect from a "discovery loop" name: this app moved away
   from always-on background SEC polling earlier (manual-only refresh,
   GitHub cron disabled) for the same reasons that apply here — 2-3x/day is
   enough for 8-K timeliness without an always-on background process.
2. **8-K parsing** (`extract8KItemNumbers`/`extract8KBody`) — finds the real
   `Item X.XX` headings (not table-of-contents/cross-reference mentions) and
   extracts the body from the first real item through `SIGNATURES`.
3. **Llama analysis** (`analyze8KWithLlama`) — sends the body to
   `CONTRADICTION_MODEL` (same model as the Truth Check Contradiction
   Engine — one model, one config, not a second one for this feature) with
   `format: 'json'`, asking for `summary`/`sentiment`/`material_event`/
   `key_items`/`confidence`. Failures are queued for retry (exponential-ish
   backoff, 5 attempts max, tracked via `llama_retry_count`/
   `llama_next_retry_at` on the filing row) — a failure never blocks the
   loop from moving to the next filing.
4. **Alerts** — one email per material 8-K, sent once
   (`alert_sent_at`, never re-sent). Non-material 8-Ks batch into a single
   daily digest at a configurable local time (default 08:00), sent at most
   once per day.
5. **Cache** — raw filing HTML is cached on disk
   (`local/data/sec-cache/`) before parsing, 5GB/1-hour-TTL hard limits,
   evicted (expired first, then oldest-by-mtime) after every discovery loop
   run.

## Alert strategy — email vs. dashboard

**Chose email (Option A), not a dashboard tab.** This app already has a
persistent, always-visible view of scout data — `/scout` already lists
filings, sentiment, and Truth Check verdicts per ticker, refreshed on
demand. A second read-only page listing the same 8-Ks with Llama summaries
would duplicate that view for marginal benefit. Email's actual value here is
*push* — being told about a material event without having the dashboard
open — which a dashboard-only approach can't provide. If you later want the
8-K analysis visible in `/scout` itself (not just email), that's a small,
separate addition — the data's already in `scout_sec_filings`.

## Setup

### 1. Environment variables (`local/.env`)

| Var | Required | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | For alerts | Reuse the value from the main app's `config.json` (`client_id`), or create a new OAuth 2.0 Client ID (type: Web application) in Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | For alerts | **New** — the browser-only Drive integration in the main app never needed one; this server-side flow does. Get it from the same OAuth client's page in Google Cloud Console. |
| `GMAIL_SEND_TO` | For alerts | The email address that receives alerts/digests. |
| `CONTRADICTION_MODEL` | No | Reused for 8-K analysis too — defaults per the existing auto-detect logic if unset. |

Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GMAIL_SEND_TO` set, discovery
and analysis still run — only alert-sending is skipped (`gmail_not_configured`
in the discovery-loop result).

### 2. One-time Google Cloud Console steps (only needed for alerts)

1. Open the OAuth Client you're reusing (or create a new Web-application one).
2. **Enable the Gmail API** for that project (APIs & Services → Library).
3. Add `https://127.0.0.1:8080/api/auth/gmail/callback` to the client's
   **Authorized redirect URIs**.
4. If your app is in "Testing" publishing status, add your own email as a
   **test user** (OAuth consent screen → Test users) — otherwise Google
   will reject the authorization.
5. Add the `.../auth/gmail.send` scope if prompted during consent (or add it
   under OAuth consent screen → Scopes).

### 3. Authorize Gmail

Visit `https://127.0.0.1:8080/auth/gmail` in a browser (accept the
self-signed cert warning), sign in, grant access. Check it worked:

```bash
curl -sk https://127.0.0.1:8080/api/auth/gmail/status
# {"configured":true,"connected":true,"sendTo":"you@example.com"}
```

### 4. Add tickers to the watchlist

Same watchlist as everything else in Proactive Scout — add a ticker via the
`+` box on `/scout`, or `POST /api/scout/watchlist {"ticker":"RKLB"}`. No
separate 8-K-specific watchlist.

### 5. Run it

- **Automatic**: nothing to do — the discovery loop starts itself ~60s after
  `docker compose up`, then every 8 hours.
- **Manual**: `POST /api/scout/discovery/run` (or the "Refresh SEC Filings"
  button on `/scout` for just the fetch step, without the Llama
  analysis/alert dispatch).
- **Pause alerts** (discovery/analysis keep running, only sending stops):
  `POST /api/scout/alert-settings {"alerts_paused": true}`
- **Change digest time**:
  `POST /api/scout/alert-settings {"digest_time": "17:30"}`
