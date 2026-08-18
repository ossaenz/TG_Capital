/**
 * Sector classification cache — Finnhub /stock/profile2, rate-limited.
 * Local-app-only: this file is never read by the static GitHub Pages app.
 */

// Underlyings that aren't real equities (indices, futures roots, broad ETFs) —
// Finnhub's company-profile endpoint doesn't meaningfully classify these.
const INDEX_ETF_SYMBOLS = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'SPX', 'SPXW', 'NDX', 'RUT', 'XSP',
  '/ES', '/MES', '/NQ', '/MNQ', '/RTY', '/M2K',
]);

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchFinnhubProfile(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${res.status} for ${symbol}`);
  return res.json();
}

// Finnhub's /stock/profile2 only returns a narrow `finnhubIndustry` string
// (e.g. "Semiconductors"), not a broad sector bucket — normalize the common
// ones to GICS-style sectors for a cleaner breakdown chart. Anything not
// listed here falls back to the raw industry string rather than "Unclassified",
// since an unmapped-but-real industry is still more useful than a blank bucket.
const INDUSTRY_TO_SECTOR = {
  'Semiconductors': 'Technology', 'Software': 'Technology', 'Technology Hardware': 'Technology',
  'Internet': 'Technology', 'Communications': 'Technology', 'IT Services': 'Technology',
  'Biotechnology': 'Healthcare', 'Pharmaceuticals': 'Healthcare', 'Medical Devices & Instruments': 'Healthcare',
  'Health Care Providers & Services': 'Healthcare',
  'Banking': 'Financials', 'Insurance': 'Financials', 'Financial Services': 'Financials',
  'Capital Markets': 'Financials', 'Consumer Finance': 'Financials',
  'Retail': 'Consumer Discretionary', 'Auto Manufacturers': 'Consumer Discretionary',
  'Hotels, Restaurants & Leisure': 'Consumer Discretionary', 'Media': 'Consumer Discretionary',
  'Food Products': 'Consumer Staples', 'Beverages': 'Consumer Staples', 'Household Products': 'Consumer Staples',
  'Oil & Gas': 'Energy', 'Energy Equipment & Services': 'Energy',
  'Aerospace & Defense': 'Industrials', 'Industrial Conglomerates': 'Industrials',
  'Airlines': 'Industrials', 'Machinery': 'Industrials',
  'Utilities': 'Utilities',
  'Real Estate': 'Real Estate', 'REITs': 'Real Estate',
  'Metals & Mining': 'Materials', 'Chemicals': 'Materials',
};
function normalizeSector(finnhubIndustry) {
  if (!finnhubIndustry) return null;
  return INDUSTRY_TO_SECTOR[finnhubIndustry] || finnhubIndustry;
}

// Shared by refreshSectorCache (trades symbols) and refreshUniverseSectorCache
// (the ticker-universe firehose) — same classify-and-cache loop, only the
// symbol source and an optional per-call cap differ. `limit` exists because
// the universe is ~7,700 symbols — at Finnhub's 1.1s/call throttle that's
// ~2.4 hours for a full pass, way too long for one discovery-loop tick, so
// the universe caller classifies a bounded batch per call and leans on
// sector_cache's own fetched_at/stale bookkeeping to resume where it left off
// across ticks, rather than needing a separate progress cursor.
async function _classifySymbols(db, apiKey, symbols, limit) {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  let needsRefresh = symbols.filter(sym => {
    const row = db.prepare('SELECT fetched_at, stale FROM sector_cache WHERE symbol = ?').get(sym);
    return !row || row.stale === 1 || row.fetched_at < cutoff;
  });
  if (limit) needsRefresh = needsRefresh.slice(0, limit);

  const upsert = db.prepare(`
    INSERT INTO sector_cache (symbol, sector, industry, source, fetched_at, stale)
    VALUES (@symbol, @sector, @industry, @source, datetime('now'), @stale)
    ON CONFLICT(symbol) DO UPDATE SET
      sector = excluded.sector, industry = excluded.industry,
      source = excluded.source, fetched_at = excluded.fetched_at, stale = excluded.stale
  `);

  let updated = 0, failed = 0;
  for (const sym of needsRefresh) {
    if (INDEX_ETF_SYMBOLS.has(sym)) {
      upsert.run({ symbol: sym, sector: 'Index/ETF', industry: null, source: 'static', stale: 0 });
      updated++;
      continue;
    }
    try {
      const profile = await fetchFinnhubProfile(sym, apiKey);
      const industry = profile?.finnhubIndustry || null;
      upsert.run({ symbol: sym, sector: normalizeSector(industry) || 'Unclassified', industry, source: 'finnhub', stale: industry ? 0 : 1 });
      updated++;
    } catch (e) {
      upsert.run({ symbol: sym, sector: 'Unclassified', industry: null, source: 'finnhub', stale: 1 });
      failed++;
    }
    await sleep(1100); // Finnhub free tier: stay comfortably under 60/min
  }

  return { checked: symbols.length, refreshed: needsRefresh.length, updated, failed };
}

/**
 * Refreshes sector_cache for every underlying currently in `trades` that's
 * missing or stale. Silent no-op if FINNHUB_API_KEY isn't configured.
 */
async function refreshSectorCache(db, apiKey) {
  if (!apiKey) return { skipped: true, reason: 'no FINNHUB_API_KEY set' };
  const symbols = db.prepare(
    `SELECT DISTINCT COALESCE(underlying, symbol) as sym FROM trades WHERE sym IS NOT NULL AND sym != ''`
  ).all().map(r => r.sym.toUpperCase());
  return _classifySymbols(db, apiKey, symbols, null);
}

/**
 * Same as refreshSectorCache, scoped to scout_ticker_universe (the 8-K
 * firehose's tracked universe) instead of trades, and capped to `limit`
 * symbols per call so one discovery-loop tick stays fast — see _classifySymbols.
 */
async function refreshUniverseSectorCache(db, apiKey, { limit = 50 } = {}) {
  if (!apiKey) return { skipped: true, reason: 'no FINNHUB_API_KEY set' };
  const symbols = db.prepare(`SELECT ticker FROM scout_ticker_universe`).all().map(r => r.ticker.toUpperCase());
  return _classifySymbols(db, apiKey, symbols, limit);
}

module.exports = { refreshSectorCache, refreshUniverseSectorCache, INDEX_ETF_SYMBOLS, fetchFinnhubProfile };
