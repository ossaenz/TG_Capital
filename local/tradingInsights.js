/**
 * "Why" trading-leak analysis — win rate by setup, holding-period patterns,
 * and deterministic (no-LLM) plain-English insights derived from them.
 * Local-app-only: this file is never read by the static GitHub Pages app.
 */

const OPENING_ACTIONS = new Set(['Sell to Open', 'Buy to Open']);
const CLOSING_ACTIONS = new Set(['Buy to Close', 'Sell to Close', 'Expired', 'Assigned', 'Exercised']);

// Same grouped-by-contract-symbol "is this position closed" heuristic already
// used by computeDashboard() in server.js — kept local to this module rather
// than shared, since it's a small, self-contained rule.
function _closedPositions(db, extraWhere = '', extraParams = []) {
  const rows = db.prepare(`
    SELECT symbol, underlying, MIN(date_iso) as opened, MAX(date_iso) as closed,
           SUM(amount) as net_pnl, COUNT(*) as legs,
           GROUP_CONCAT(DISTINCT action) as actions
    FROM trades WHERE asset_type = 'OPTION' ${extraWhere}
    GROUP BY symbol
  `).all(...extraParams);

  const hasOpen    = p => p.actions.split(',').some(a => OPENING_ACTIONS.has(a.trim()));
  const hasClose    = p => p.actions.split(',').some(a => CLOSING_ACTIONS.has(a.trim()));
  const allExpired  = p => p.actions.split(',').every(a => a.trim() === 'Expired');
  return rows.filter(p => (hasOpen(p) && hasClose(p)) || allExpired(p));
}

function computeWinRateBySetup(db) {
  const closed = _closedPositions(db);
  const strategyOf = db.prepare(
    `SELECT strategy FROM journal_entries WHERE symbol = ? AND strategy IS NOT NULL AND strategy != '' LIMIT 1`
  );

  const bySetup = new Map();
  for (const p of closed) {
    const tag = strategyOf.get(p.symbol)?.strategy || 'Untagged';
    if (!bySetup.has(tag)) bySetup.set(tag, { setup: tag, trades: 0, wins: 0, totalPnl: 0 });
    const b = bySetup.get(tag);
    b.trades++;
    b.totalPnl += p.net_pnl;
    if (p.net_pnl > 0) b.wins++;
  }

  return [...bySetup.values()]
    .map(b => ({ ...b, winRate: b.trades > 0 ? (b.wins / b.trades) * 100 : 0, avgPnl: b.trades > 0 ? b.totalPnl / b.trades : 0 }))
    .sort((a, b) => a.totalPnl - b.totalPnl); // worst first — the leaks you care about are at the top
}

function computeHoldingPeriodBreakdown(db) {
  const closed = _closedPositions(db);
  const buckets = {
    'Same day':  { pnl: 0, count: 0, wins: 0 },
    '1-5 days':  { pnl: 0, count: 0, wins: 0 },
    '6-30 days': { pnl: 0, count: 0, wins: 0 },
    '30+ days':  { pnl: 0, count: 0, wins: 0 },
  };
  for (const p of closed) {
    const days = Math.round((new Date(p.closed) - new Date(p.opened)) / 86400000);
    const key = days === 0 ? 'Same day' : days <= 5 ? '1-5 days' : days <= 30 ? '6-30 days' : '30+ days';
    buckets[key].pnl += p.net_pnl;
    buckets[key].count++;
    if (p.net_pnl > 0) buckets[key].wins++;
  }
  return Object.entries(buckets).map(([bucket, b]) => ({
    bucket, ...b, winRate: b.count > 0 ? (b.wins / b.count) * 100 : 0,
  }));
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Deterministic, template-based insights — no LLM involved. These are
 * backward-looking facts derived from your own data, not judgment calls,
 * so a rule-based generator is more trustworthy than free-form narration.
 */
function generateLeakInsights(db) {
  const bySetup = computeWinRateBySetup(db);
  const byHolding = computeHoldingPeriodBreakdown(db);
  const byDOW = db.prepare(`
    SELECT strftime('%w', date_iso) as dow, SUM(amount) as pnl, COUNT(*) as n
    FROM trades WHERE asset_type = 'OPTION' GROUP BY dow
  `).all();

  const insights = [];

  const drags = bySetup.filter(s => s.totalPnl < 0 && s.trades >= 5);
  if (drags.length) {
    const d = drags[0];
    insights.push(
      `Your biggest leak is "${d.setup}" — ${d.trades} trades, ${d.winRate.toFixed(0)}% win rate, ` +
      `$${d.totalPnl.toFixed(2)} net. You trade this setup often but it's losing money.`
    );
  }

  const worstDay = byDOW.filter(d => d.n >= 5).sort((a, b) => a.pnl - b.pnl)[0];
  if (worstDay && worstDay.pnl < 0) {
    insights.push(
      `You consistently lose money trading on ${DOW_NAMES[Number(worstDay.dow)]} ` +
      `(-$${Math.abs(worstDay.pnl).toFixed(2)} over ${worstDay.n} trades).`
    );
  }

  const sameDay = byHolding.find(b => b.bucket === 'Same day');
  const longHold = byHolding.find(b => b.bucket === '30+ days');
  if (sameDay?.count >= 5 && longHold?.count >= 5 && sameDay.winRate > longHold.winRate + 15) {
    insights.push(
      `Same-day exits win more often (${sameDay.winRate.toFixed(0)}%) than positions held 30+ days ` +
      `(${longHold.winRate.toFixed(0)}%) — worth checking whether losers are being held too long.`
    );
  }

  const bestSetup = bySetup.length ? bySetup[bySetup.length - 1] : null;
  if (bestSetup && bestSetup.totalPnl > 0 && bestSetup.trades >= 5) {
    insights.push(
      `Your best-performing setup is "${bestSetup.setup}" — ${bestSetup.trades} trades, ` +
      `${bestSetup.winRate.toFixed(0)}% win rate, $${bestSetup.totalPnl.toFixed(2)} net.`
    );
  }

  if (!insights.length) {
    insights.push('No clear leaks detected yet — either the data set is still small, or results are fairly consistent across setups and days.');
  }
  return insights;
}

module.exports = { computeWinRateBySetup, computeHoldingPeriodBreakdown, generateLeakInsights };
