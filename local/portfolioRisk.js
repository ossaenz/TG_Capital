/**
 * Portfolio-level risk views: aggregate Greeks exposure, expiration/assignment
 * risk calendar, and sector/ticker concentration warnings — all derived from
 * currently open positions (fetchLiveAccountSnapshot()'s `positions` array).
 * Local-app-only: this file is never read by the static GitHub Pages app.
 */

const EXPIRING_SOON_DAYS = 7;
const CONCENTRATION_WARNING_PCT = 25; // % of total open-position value in one bucket

function _daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr) - new Date()) / 86400000);
}

function _isoDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Schwab's chain expiry keys look like "2026-01-16:3" (date:daysToExpiry);
// strike keys are stringified numbers, sometimes with different trailing
// zeros than our stored strike — match both by normalized value, not string equality.
function _findContract(map, expiryRaw, strike) {
  const expiry = _isoDate(expiryRaw);
  if (!map || !expiry || strike == null) return null;
  const expKey = Object.keys(map).find(k => k.split(':')[0] === expiry);
  if (!expKey) return null;
  const strikes = map[expKey];
  const strikeKey = Object.keys(strikes || {}).find(k => Number(k) === Number(strike));
  if (!strikeKey) return null;
  const arr = strikes[strikeKey];
  return Array.isArray(arr) ? arr[0] : arr;
}

/**
 * fetchChain(underlying) => raw Schwab /chains response for that underlying,
 * injected so this module doesn't need to know about schwabMarket()/auth.
 */
async function computeGreeksAndExpiry(positions, fetchChain) {
  const optionPositions = positions.filter(p => p.assetType === 'OPTION' && p.underlying);
  const byUnderlying = new Map();
  for (const p of optionPositions) {
    if (!byUnderlying.has(p.underlying)) byUnderlying.set(p.underlying, []);
    byUnderlying.get(p.underlying).push(p);
  }

  let netDelta = 0, netTheta = 0, netVega = 0, netGamma = 0;
  const perPosition = [];
  const expirationCalendar = [];
  const chainErrors = [];

  for (const [underlying, posList] of byUnderlying) {
    let chain;
    try {
      chain = await fetchChain(underlying);
    } catch (e) {
      chainErrors.push({ underlying, error: e.message });
      continue;
    }
    if (!chain || chain.error) { chainErrors.push({ underlying, error: chain?.error || 'no chain data' }); continue; }

    const spot = chain.underlyingPrice ?? chain.underlying?.mark ?? null;

    for (const pos of posList) {
      const signedQty = (pos.longQty || 0) - (pos.shortQty || 0);
      if (signedQty === 0) continue;

      const days = _daysUntil(pos.expiry);
      const itm = spot != null && pos.strike != null
        ? (pos.putCall === 'PUT' ? spot < pos.strike : spot > pos.strike)
        : null;

      if (days != null && days <= EXPIRING_SOON_DAYS) {
        expirationCalendar.push({
          underlying, symbol: pos.symbol, putCall: pos.putCall, strike: pos.strike,
          expiry: pos.expiry, daysToExpiry: days, signedQty, spot, itm,
          marketValue: pos.marketValue,
        });
      }

      const map = pos.putCall === 'PUT' ? chain.putExpDateMap : chain.callExpDateMap;
      const contract = _findContract(map, pos.expiry, pos.strike);
      if (!contract) continue; // no matching live contract found — skip rather than fake a greek

      const mult = signedQty * 100; // 1 contract = 100 shares equivalent
      const delta = Number(contract.delta ?? 0) * mult;
      const theta = Number(contract.theta ?? 0) * mult;
      const vega  = Number(contract.vega  ?? 0) * mult;
      const gamma = Number(contract.gamma ?? 0) * mult;
      netDelta += delta; netTheta += theta; netVega += vega; netGamma += gamma;
      perPosition.push({ underlying, symbol: pos.symbol, signedQty, delta, theta, vega, gamma });
    }
  }

  expirationCalendar.sort((a, b) => a.daysToExpiry - b.daysToExpiry);

  return { netDelta, netTheta, netVega, netGamma, perPosition, expirationCalendar, chainErrors };
}

/**
 * sectorBySymbol: plain object { TICKER: 'Sector Name' }, e.g. from sector_cache.
 */
function computeConcentration(positions, sectorBySymbol) {
  const totalValue = positions.reduce((s, p) => s + Math.abs(p.marketValue || 0), 0);
  if (totalValue <= 0) return { byTicker: [], bySector: [], warnings: [] };

  const byTickerMap = new Map();
  const bySectorMap = new Map();
  for (const p of positions) {
    const ticker = p.underlying || p.symbol;
    const val = Math.abs(p.marketValue || 0);
    byTickerMap.set(ticker, (byTickerMap.get(ticker) || 0) + val);
    const sector = sectorBySymbol?.[ticker] || 'Unclassified';
    bySectorMap.set(sector, (bySectorMap.get(sector) || 0) + val);
  }

  const byTicker = [...byTickerMap.entries()]
    .map(([ticker, value]) => ({ ticker, value, pct: (value / totalValue) * 100 }))
    .sort((a, b) => b.pct - a.pct);
  const bySector = [...bySectorMap.entries()]
    .map(([sector, value]) => ({ sector, value, pct: (value / totalValue) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  const warnings = [];
  for (const t of byTicker) {
    if (t.pct >= CONCENTRATION_WARNING_PCT) {
      warnings.push(`${t.ticker} is ${t.pct.toFixed(0)}% of your open position value — concentrated in a single ticker.`);
    }
  }
  for (const s of bySector) {
    if (s.pct >= CONCENTRATION_WARNING_PCT && s.sector !== 'Unclassified') {
      warnings.push(`${s.sector} is ${s.pct.toFixed(0)}% of your open position value — concentrated in a single sector.`);
    }
  }

  return { byTicker, bySector, warnings };
}

module.exports = { computeGreeksAndExpiry, computeConcentration, EXPIRING_SOON_DAYS, CONCENTRATION_WARNING_PCT };
