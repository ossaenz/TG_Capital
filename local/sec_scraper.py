# No Gmail or Google API dependencies. All output goes to https://osflex.me/chamuco
# (Caddy-proxied to this app's own POST /api/v1/ingest — see local/server.js) via
# Bearer token, nowhere else.
import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

logger = logging.getLogger("sec_scraper")

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
# External alias, proxied by Caddy on the `osflex.me` host straight through to this
# app's POST /api/v1/ingest — see the Caddyfile `handle /chamuco { rewrite * /api/v1/ingest; ... }`
# block. Leave this URL as-is; only the proxy target's own naming was ever "chamuco".
SCOUT_INGEST_URL = "https://osflex.me/chamuco"
MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 5
FORM_TYPES = {"8-K", "10-K", "10-Q", "20-F", "6-K"}  # 20-F/6-K: foreign private issuer equivalents of 10-K/10-Q
# SEC asks requesters to keep request rates reasonable; this is a small
# per-ticker courtesy delay, not a hard SEC-imposed limit.
PER_TICKER_DELAY_SECONDS = 0.3

# Default watchlist file — edit tickers.json to change the list without
# touching this script. Path is relative to this file, not the CWD, so it
# resolves the same whether run directly or via `act`/GitHub Actions.
DEFAULT_TICKERS_FILE = Path(__file__).parent / "tickers.json"


def load_default_tickers():
    try:
        with open(DEFAULT_TICKERS_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        tickers = data.get("tickers", [])
        if not tickers:
            raise ValueError("tickers.json has no tickers")
        return [str(t).strip().upper() for t in tickers if str(t).strip()]
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not load default tickers from {DEFAULT_TICKERS_FILE}: {exc}") from exc


def _request_with_retry(method, url, **kwargs):
    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = requests.request(method, url, **kwargs)
            return response
        except requests.exceptions.RequestException as exc:
            last_error = exc
            logger.warning(
                "Request to %s failed (attempt %d/%d): %s",
                url, attempt, MAX_ATTEMPTS, exc,
            )
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_SECONDS)
    raise last_error


def _sec_headers():
    user_agent = os.environ.get("SEC_USER_AGENT", "TG-Capital-ProactiveScout/1.0 contact@osflex.me")
    return {"User-Agent": user_agent}


def fetch_ticker_map():
    """Fetch SEC's official ticker -> {cik, title} mapping."""
    response = _request_with_retry("GET", TICKERS_URL, headers=_sec_headers(), timeout=30)
    if not (200 <= response.status_code < 300):
        raise RuntimeError(f"Failed to fetch ticker map: {response.status_code}: {response.text}")
    raw = response.json()
    return {
        entry["ticker"].upper(): {"cik": str(entry["cik_str"]), "title": entry["title"]}
        for entry in raw.values()
    }


def fetch_filings_for_ticker(ticker, cik, title, start_date, end_date):
    """Fetch recent filings for one CIK, filtered to FORM_TYPES and the date range."""
    padded_cik = cik.zfill(10)
    url = SUBMISSIONS_URL.format(cik=padded_cik)
    response = _request_with_retry("GET", url, headers=_sec_headers(), timeout=30)
    if response.status_code == 404:
        logger.warning("No SEC submissions found for %s (CIK %s)", ticker, cik)
        return []
    if not (200 <= response.status_code < 300):
        raise RuntimeError(f"Failed to fetch submissions for {ticker}: {response.status_code}: {response.text}")

    recent = response.json().get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    accessions = recent.get("accessionNumber", [])
    primary_docs = recent.get("primaryDocument", [])
    descriptions = recent.get("primaryDocDescription", [])

    filings = []
    for i, form in enumerate(forms):
        if form not in FORM_TYPES:
            continue
        filed_at = dates[i]
        if not (start_date <= filed_at <= end_date):
            continue
        adsh = accessions[i]
        adsh_nodash = adsh.replace("-", "")
        primary_doc = primary_docs[i] if i < len(primary_docs) else ""
        cik_int = str(int(cik))
        filing_url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{adsh_nodash}/{primary_doc or adsh + '-index.htm'}"

        filings.append({
            "ticker": ticker,
            "accession_number": adsh,
            "entity_name": title,
            "form_type": form,
            "filed_at": f"{filed_at}T00:00:00Z",
            "description": descriptions[i] if i < len(descriptions) else "",
            "filing_url": filing_url,
        })

    return filings


def fetch_filings_for_tickers(tickers, start_date, end_date):
    ticker_map = fetch_ticker_map()
    all_filings = []
    for i, ticker in enumerate(tickers):
        entry = ticker_map.get(ticker.upper())
        if not entry:
            logger.warning("Ticker %s not found in SEC's ticker map — skipping", ticker)
            continue
        filings = fetch_filings_for_ticker(ticker.upper(), entry["cik"], entry["title"], start_date, end_date)
        logger.info("Fetched %d filing(s) for %s", len(filings), ticker.upper())
        all_filings.extend(filings)
        if i < len(tickers) - 1:
            time.sleep(PER_TICKER_DELAY_SECONDS)
    return all_filings


def write_github_step_summary(tickers, filings):
    """Append a markdown report of what was fetched to $GITHUB_STEP_SUMMARY.
    No-op outside GitHub Actions (the env var is only set there)."""
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return

    counts = {}
    for f in filings:
        counts[f["ticker"]] = counts.get(f["ticker"], 0) + 1

    lines = ["## SEC Filings Fetched", ""]
    lines.append(f"**{len(filings)}** filing(s) across **{len(tickers)}** ticker(s): {', '.join(tickers)}")
    lines.append("")
    lines.append("| Ticker | Filings |")
    lines.append("|---|---|")
    for ticker in tickers:
        lines.append(f"| {ticker} | {counts.get(ticker, 0)} |")
    lines.append("")

    if filings:
        lines.append("| Ticker | Form | Entity | Filed | Link |")
        lines.append("|---|---|---|---|---|")
        for f in sorted(filings, key=lambda x: x.get("filed_at", ""), reverse=True):
            lines.append(
                f"| {f['ticker']} | {f['form_type']} | {f['entity_name']} | {f['filed_at'][:10]} "
                f"| [view]({f['filing_url']}) |"
            )
    else:
        lines.append("_No filings matched the date range / form types for these tickers._")

    with open(summary_path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def send_to_scout(tickers, filings):
    token = os.environ.get("SCOUT_INGEST_TOKEN", "")
    if not token:
        raise RuntimeError("SCOUT_INGEST_TOKEN environment variable is missing or empty")

    body = {
        "source": "sec_edgar",
        "kind": "filing_batch",
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "payload": {
            "tickers": tickers,
            "filings": filings,
        },
        "metadata": {},
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    response = _request_with_retry("POST", SCOUT_INGEST_URL, json=body, headers=headers, timeout=30)
    logger.info("Proactive Scout ingest endpoint responded with status %d", response.status_code)
    if not (200 <= response.status_code < 300):
        raise RuntimeError(
            f"Proactive Scout ingest endpoint returned status {response.status_code}: {response.text}"
        )
    return response.status_code


def parse_args():
    parser = argparse.ArgumentParser(description="SEC EDGAR filing scraper for the Proactive Scout")
    parser.add_argument(
        "--tickers",
        required=False,
        default=None,
        help="Comma-separated stock tickers, e.g. TSLA,NVDA,PLTR (default: load from tickers.json)",
    )
    parser.add_argument("--start_date", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end_date", required=True, help="End date YYYY-MM-DD")
    return parser.parse_args()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()

    if args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = load_default_tickers()
        logger.info("No --tickers given, loaded %d from %s", len(tickers), DEFAULT_TICKERS_FILE)
    if not tickers:
        raise RuntimeError("No valid tickers provided")

    filings = fetch_filings_for_tickers(tickers, args.start_date, args.end_date)
    logger.info("Fetched %d total filings for %d ticker(s): %s", len(filings), len(tickers), ", ".join(tickers))
    write_github_step_summary(tickers, filings)

    send_to_scout(tickers, filings)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        logger.error("SEC scraper failed: %s", exc)
        sys.exit(1)
    sys.exit(0)
