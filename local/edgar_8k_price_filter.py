"""Fetches today's 8-K filings from SEC EDGAR's daily index and filters out
penny stocks using a live Finnhub quote for each filer.

EDGAR's XBRL "company facts" endpoint does NOT contain market share price —
it's self-reported financial-statement data (revenue, EPS, shares outstanding),
not stock quotes. Price filtering here uses Finnhub's /quote endpoint instead.

Requires env vars:
  SEC_USER_AGENT   e.g. "TG Capital admin@example.com" — SEC requires a real,
                   descriptive User-Agent on every request or it may block you.
  FINNHUB_API_KEY  free tier at finnhub.io (60 calls/min).
"""
import os
import time
from datetime import date, timedelta

import requests

SEC_USER_AGENT = os.environ.get("SEC_USER_AGENT", "")
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "")
FINNHUB_DELAY_SECONDS = 1.1  # stays under the free tier's 60 calls/min

_session = requests.Session()
_ticker_map_cache = None  # CIK (int) -> ticker, built once per process


def _sec_get(url, **kwargs):
    """GET with SEC's required User-Agent header and one retry on failure —
    SEC returns 403 for requests missing a descriptive User-Agent."""
    if not SEC_USER_AGENT:
        raise RuntimeError("SEC_USER_AGENT env var is required (e.g. 'YourApp you@example.com')")
    headers = {"User-Agent": SEC_USER_AGENT}
    for attempt in range(2):
        try:
            r = _session.get(url, headers=headers, timeout=15, **kwargs)
            if r.status_code == 404:
                return r  # caller decides how to handle (e.g. weekend/holiday index)
            r.raise_for_status()
            return r
        except requests.RequestException:
            if attempt == 1:
                raise
            time.sleep(1)


def _load_ticker_map():
    """CIK -> ticker, from EDGAR's official ticker list. Fetched once and
    cached for the life of the process — this file changes rarely."""
    global _ticker_map_cache
    if _ticker_map_cache is not None:
        return _ticker_map_cache
    r = _sec_get("https://www.sec.gov/files/company_tickers.json")
    data = r.json()
    _ticker_map_cache = {int(entry["cik_str"]): entry["ticker"].upper() for entry in data.values()}
    return _ticker_map_cache


def _fetch_daily_index(day):
    """Every filing SEC received on `day` (a date), any form type — one bulk
    text file, not a paginated search. Returns None if there's no index for
    that day (weekend/holiday)."""
    quarter = (day.month - 1) // 3 + 1
    url = f"https://www.sec.gov/Archives/edgar/daily-index/{day.year}/QTR{quarter}/form.{day.strftime('%Y%m%d')}.idx"
    r = _sec_get(url)
    if r.status_code == 404:
        return None
    return r.text


import re

# Column widths in the .idx header are visually misleading (the two-line header
# doesn't share a coordinate frame with the data rows — confirmed against a real
# file: fixed-offset slicing cut "20260814" into "2026081"/"4"). Anchoring on the
# fields' actual shapes (12-char form type, then name, then numeric CIK, 8-digit
# date, file path) is robust regardless of company-name length.
_IDX_ROW_RE = re.compile(r"^(.{12})(.*?)\s+(\d+)\s+(\d{8})\s+(\S+)\s*$")


def _parse_8k_rows(index_text):
    """One header block then one row per filing, any form type."""
    rows = []
    for line in index_text.splitlines():
        m = _IDX_ROW_RE.match(line)
        if not m:
            continue
        form_type = m.group(1).strip()
        if form_type not in ("8-K", "8-K/A"):
            continue
        rows.append({
            "form_type": form_type,
            "company": m.group(2).strip(),
            "cik": int(m.group(3)),
            "filed_at": m.group(4),
            "filing_url": f"https://www.sec.gov/Archives/{m.group(5)}",
        })
    return rows


def _get_price(ticker):
    """Current price via Finnhub /quote. Returns None on any failure (missing
    key, unknown symbol, network error) rather than raising — a single bad
    quote shouldn't take down the whole filter pass."""
    if not FINNHUB_API_KEY:
        raise RuntimeError("FINNHUB_API_KEY env var is required")
    try:
        r = _session.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": ticker, "token": FINNHUB_API_KEY},
            timeout=10,
        )
        r.raise_for_status()
        price = r.json().get("c")  # "c" = current price; 0 means "no data" for this symbol
        return price if price else None
    except requests.RequestException:
        return None


def get_filtered_8k_filings(price_floor=5.0, day=None):
    """Returns 8-K filings from `day` (default: today, falling back to the
    most recent prior business day if today has no index yet — e.g. run
    before EDGAR publishes it) where the filer's ticker is known and its
    current price is >= price_floor. Each result:
      {ticker, company, cik, form_type, filed_at, filing_url, price}
    """
    day = day or date.today()
    index_text = _fetch_daily_index(day)
    if index_text is None:
        index_text = _fetch_daily_index(day - timedelta(days=1))
    if index_text is None:
        return []

    filings = _parse_8k_rows(index_text)
    ticker_map = _load_ticker_map()

    results = []
    price_cache = {}  # ticker -> price, so a company with multiple 8-Ks today only gets quoted once
    for f in filings:
        ticker = ticker_map.get(f["cik"])
        if not ticker:
            continue  # no exchange-listed ticker on file for this CIK — can't price-check it

        if ticker not in price_cache:
            price_cache[ticker] = _get_price(ticker)
            time.sleep(FINNHUB_DELAY_SECONDS)
        price = price_cache[ticker]
        if price is None or price < price_floor:
            continue

        results.append({**f, "ticker": ticker, "price": price})

    return results


if __name__ == "__main__":
    filtered = get_filtered_8k_filings(price_floor=5.0)
    print(f"{len(filtered)} 8-K filing(s) at/above $5.00:\n")
    for f in filtered:
        print(f"  {f['ticker']:<6} ${f['price']:<8.2f} {f['company']} — {f['filing_url']}")
