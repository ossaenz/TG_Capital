/**
 * Pure position/PnL engine — the "brain" behind plutusTools.js, deliberately
 * decoupled from SQLite/Express/Ollama. Every export here is a plain
 * function of (array of trade-row objects) -> plain objects; nothing in
 * this file touches a database connection or an HTTP request, so it can be
 * unit-tested with a hand-written trade array and, if this app is ever
 * ported to a different backend/store, moved over unchanged as long as the
 * caller can still produce the same trade-row shape:
 *   { date, action, symbol, underlying, asset_type, quantity, price, fees, amount }
 *
 * Two engines live here, because equities and options are genuinely
 * different problems, not two branches of one algorithm:
 *
 * - Options: identity lives in the contract symbol (underlying+expiry+
 *   strike+right). A position is "closed" when its action set has both an
 *   opening and a closing action (or is all Expired). ROLLS are handled
 *   explicitly (see buildOptionChains): closing one contract and opening a
 *   different contract, same underlying, same right (call/put), same day,
 *   is treated as one continuous logical trade — a chain — with aggregate
 *   PnL/hold-time across every leg, while each leg's own contribution stays
 *   inspectable via chain.legs[].
 *
 * - Equities: identity is just share count per ticker. Buys/sells are
 *   matched FIFO (the same convention the IRS defaults to for uncovered
 *   lots), producing one closed "lot" per matched buy/sell portion plus any
 *   unmatched remainder as an open lot. Corporate actions (splits,
 *   transfers, dividends, journaled shares) are explicitly out of scope —
 *   "Equity trades (simple buy/sell)" only; adjusting basis for those would
 *   need the same lot-carry logic the tax rules in server.js's system
 *   prompt already describe, and duplicating that here would drift.
 *
 * Both engines emit the same POSITION SHAPE so callers (get_positions,
 * compute_metrics) don't need two code paths:
 *   {
 *     asset_type, underlying, status, opened, closed, hold_days,
 *     net_pnl, total_fees, is_roll, roll_count, has_incomplete_pricing,
 *     legs: [ { symbol, opened, closed, quantity, net_pnl, total_fees, status } ]
 *   }
 * roll_count is always 0 for equity lots — rolling is an options concept.
 */

const OPENING_ACTIONS = new Set(['Sell to Open', 'Buy to Open']);
const CLOSING_ACTIONS = new Set(['Buy to Close', 'Sell to Close', 'Expired', 'Assigned', 'Exercised']);
// Only these two represent an *active* close (trader-initiated, same-day
// roll-eligible) — Expired/Assigned/Exercised are terminal events distinct
// from "closing early to open something else," so they never link a roll.
const ACTIVE_CLOSE_ACTIONS = new Set(['Buy to Close', 'Sell to Close']);
const PREMIUM_BEARING_ACTIONS = new Set(['Sell to Open', 'Buy to Open', 'Buy to Close', 'Sell to Close']);

function _holdDays(opened, closed) {
  if (!opened || !closed) return null;
  return Math.max(0, Math.round((new Date(closed) - new Date(opened)) / 86400000));
}

function _optionRight(symbol) {
  const trimmed = (symbol || '').trim();
  if (trimmed.endsWith(' C')) return 'C';
  if (trimmed.endsWith(' P')) return 'P';
  return null;
}

/** Parse "TICKER MM/DD/YYYY STRIKE C" -> "YYYY-MM-DD", or null if unparseable. */
function _optionExpiry(symbol) {
  const m = (symbol || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// America/New_York, not UTC — the account is US-based and this only exists to
// flag stale "still open" contracts, so a day off around midnight UTC would
// misfire (this bit a synthetic test: UTC was already Aug 1 while it was
// still Jul 31 in the trader's own timezone). Matches the "today" convention
// server.js already uses in the chat system prompt for the same reason.
function _todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Group OPTION trade rows into one record per exact contract symbol. */
function _groupContracts(trades) {
  const bySymbol = new Map();
  for (const t of trades) {
    if (t.asset_type !== 'OPTION') continue;
    if (!bySymbol.has(t.symbol)) {
      bySymbol.set(t.symbol, {
        symbol: t.symbol, underlying: t.underlying, right: _optionRight(t.symbol),
        opened: t.date, closed: t.date, net_pnl: 0, total_fees: 0, legs: 0,
        actions: new Set(), hasIncompletePricing: false,
      });
    }
    const c = bySymbol.get(t.symbol);
    if (t.date < c.opened) c.opened = t.date;
    if (t.date > c.closed) c.closed = t.date;
    c.net_pnl += t.amount;
    c.total_fees += t.fees || 0;
    c.legs += 1;
    c.actions.add(t.action);
    if (PREMIUM_BEARING_ACTIONS.has(t.action) && t.amount === 0 && (t.price || 0) === 0) {
      c.hasIncompletePricing = true;
    }
  }

  const contracts = [];
  for (const c of bySymbol.values()) {
    const hasOpen = [...c.actions].some(a => OPENING_ACTIONS.has(a));
    const hasClose = [...c.actions].some(a => CLOSING_ACTIONS.has(a));
    const allExpired = [...c.actions].every(a => a === 'Expired');
    const status = (hasOpen && hasClose) || allExpired ? 'closed' : hasOpen ? 'open' : 'unknown';
    if (status === 'unknown') continue;
    const openAction = [...c.actions].find(a => OPENING_ACTIONS.has(a)) || null;
    const closeAction = [...c.actions].find(a => ACTIVE_CLOSE_ACTIONS.has(a)) || null;
    const expiry = _optionExpiry(c.symbol);
    contracts.push({
      ...c, status, openAction, closeAction, expiry,
      net_pnl: +c.net_pnl.toFixed(2), total_fees: +c.total_fees.toFixed(2),
      prevSymbol: null, nextSymbol: null,
      // status='open' with no closing row past its own expiry almost always
      // means the closing/expiration event just isn't in this dataset (a
      // sync/import gap), not real ongoing exposure — flagged rather than
      // presented as a live open position.
      pastExpiryUnclosed: status === 'open' && !!expiry && expiry < _todayISO(),
    });
  }
  return contracts;
}

/**
 * Link same-day roll pairs: a contract closed via an ACTIVE close (BTC/STC)
 * whose closed-date equals another contract's opened-date, same underlying,
 * same right, with the complementary opening action (BTC->STO, STC->BTO).
 * Matching is same-day only (confirmed against this account's real roll
 * pattern — same-underlying/same-day BTC+STO pairs) and FIFO within a
 * (underlying, date, right, openAction) bucket if more than one candidate
 * exists that day, so it stays O(n) and deterministic rather than search.
 */
function _linkRolls(contracts) {
  const byOpenKey = new Map(); // `${underlying}|${date}|${right}|${openAction}` -> queue of candidate contracts
  for (const c of contracts) {
    if (!c.openAction) continue;
    const key = `${c.underlying}|${c.opened}|${c.right}|${c.openAction}`;
    if (!byOpenKey.has(key)) byOpenKey.set(key, []);
    byOpenKey.get(key).push(c);
  }

  const complement = { 'Buy to Close': 'Sell to Open', 'Sell to Close': 'Buy to Open' };
  for (const c of contracts) {
    if (c.status !== 'closed' || !c.closeAction) continue;
    const wantOpenAction = complement[c.closeAction];
    const key = `${c.underlying}|${c.closed}|${c.right}|${wantOpenAction}`;
    const queue = byOpenKey.get(key);
    if (!queue || !queue.length) continue;
    const idx = queue.findIndex(cand => cand !== c && !cand.prevSymbol);
    if (idx === -1) continue;
    const next = queue.splice(idx, 1)[0];
    c.nextSymbol = next.symbol;
    next.prevSymbol = c.symbol;
  }
  return contracts;
}

/** Build option roll chains from raw trade rows. Every closed/open OPTION
 *  contract appears in exactly one chain — chains of length 1 are the
 *  ordinary (non-rolled) case, so callers don't need a separate code path. */
function buildOptionChains(trades) {
  const contracts = _linkRolls(_groupContracts(trades));
  const bySymbol = new Map(contracts.map(c => [c.symbol, c]));

  const chains = [];
  for (const c of contracts) {
    if (c.prevSymbol) continue; // not a chain head
    const legs = [];
    let cur = c;
    while (cur) { legs.push(cur); cur = cur.nextSymbol ? bySymbol.get(cur.nextSymbol) : null; }

    const last = legs[legs.length - 1];
    const status = last.status;
    const netPnl = +legs.reduce((s, l) => s + l.net_pnl, 0).toFixed(2);
    const totalFees = +legs.reduce((s, l) => s + l.total_fees, 0).toFixed(2);
    chains.push({
      asset_type: 'OPTION',
      underlying: c.underlying,
      status,
      opened: legs[0].opened,
      closed: status === 'closed' ? last.closed : null,
      hold_days: status === 'closed' ? _holdDays(legs[0].opened, last.closed) : null,
      net_pnl: netPnl,
      total_fees: totalFees,
      is_roll: legs.length > 1,
      roll_count: legs.length - 1,
      has_incomplete_pricing: legs.some(l => l.hasIncompletePricing),
      past_expiry_unclosed: legs.some(l => l.pastExpiryUnclosed),
      legs: legs.map(l => ({
        symbol: l.symbol, expiry: l.expiry, opened: l.opened, closed: l.status === 'closed' ? l.closed : null,
        status: l.status, legs: l.legs, net_pnl: l.net_pnl, total_fees: l.total_fees,
        open_action: l.openAction, close_action: l.closeAction || (l.status === 'closed' ? [...l.actions].find(a => CLOSING_ACTIONS.has(a)) : null),
        past_expiry_unclosed: l.pastExpiryUnclosed,
      })),
    });
  }
  return chains;
}

/** FIFO buy/sell lot matching for equities. See module docstring for scope
 *  (Buy/Sell only — splits/transfers/dividends are not lot-adjusted here). */
function buildEquityLots(trades) {
  const bySymbol = new Map();
  for (const t of trades) {
    if (t.asset_type !== 'EQUITY' || (t.action !== 'Buy' && t.action !== 'Sell')) continue;
    const key = t.underlying || t.symbol;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(t);
  }

  const positions = [];
  for (const [symbol, rows] of bySymbol) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
    const openLots = []; // { opened, qtyRemaining, originalQty, amount, fees }

    for (const t of rows) {
      if (t.action === 'Buy') {
        openLots.push({ opened: t.date, qtyRemaining: t.quantity, originalQty: t.quantity, amount: t.amount, fees: t.fees || 0 });
        continue;
      }
      // Sell: consume open lots FIFO
      let remainingToSell = t.quantity;
      while (remainingToSell > 0 && openLots.length) {
        const lot = openLots[0];
        const consumed = Math.min(remainingToSell, lot.qtyRemaining);
        const sellPortion = t.amount * (consumed / t.quantity);
        const buyPortion = lot.amount * (consumed / lot.originalQty);
        const feesPortion = (t.fees || 0) * (consumed / t.quantity) + lot.fees * (consumed / lot.originalQty);
        positions.push({
          asset_type: 'EQUITY', underlying: symbol, status: 'closed',
          opened: lot.opened, closed: t.date, hold_days: _holdDays(lot.opened, t.date),
          net_pnl: +(sellPortion + buyPortion).toFixed(2), total_fees: +feesPortion.toFixed(2),
          is_roll: false, roll_count: 0, has_incomplete_pricing: false,
          legs: [{ symbol, opened: lot.opened, closed: t.date, status: 'closed', quantity: consumed, net_pnl: +(sellPortion + buyPortion).toFixed(2), total_fees: +feesPortion.toFixed(2) }],
        });
        lot.qtyRemaining -= consumed;
        remainingToSell -= consumed;
        if (lot.qtyRemaining <= 0) openLots.shift();
      }
      if (remainingToSell > 0) {
        // Sold more than this dataset shows being bought (short sale, or the
        // buy predates the synced window) — no cost basis to match against,
        // so report it honestly instead of fabricating a basis of $0.
        positions.push({
          asset_type: 'EQUITY', underlying: symbol, status: 'closed',
          opened: null, closed: t.date, hold_days: null,
          net_pnl: null, total_fees: null,
          is_roll: false, roll_count: 0, has_incomplete_pricing: true,
          legs: [{ symbol, opened: null, closed: t.date, status: 'closed', quantity: remainingToSell, net_pnl: null, total_fees: null, note: 'No matching buy lot in this dataset — cost basis unknown.' }],
        });
      }
    }

    for (const lot of openLots) {
      positions.push({
        asset_type: 'EQUITY', underlying: symbol, status: 'open',
        opened: lot.opened, closed: null, hold_days: null,
        net_pnl: 0, total_fees: lot.fees, is_roll: false, roll_count: 0, has_incomplete_pricing: false,
        legs: [{ symbol, opened: lot.opened, closed: null, status: 'open', quantity: lot.qtyRemaining, net_pnl: 0, total_fees: lot.fees }],
      });
    }
  }
  return positions;
}

function buildPositions(trades, { assetType = 'ALL' } = {}) {
  const positions = [];
  if (assetType === 'OPTION' || assetType === 'ALL') positions.push(...buildOptionChains(trades));
  if (assetType === 'EQUITY' || assetType === 'ALL') positions.push(...buildEquityLots(trades));
  return positions;
}

function _stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Running cumulative P&L + peak-to-trough drawdown over a date-ascending
 *  {date, pnl} series. */
function computeDrawdown(dailySeries) {
  let cum = 0, peak = 0, maxDrawdown = 0;
  const points = dailySeries.map(d => {
    cum += d.pnl;
    if (cum > peak) peak = cum;
    const drawdown = +(cum - peak).toFixed(2);
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    return { date: d.date, period_pnl: +d.pnl.toFixed(2), cumulative_pnl: +cum.toFixed(2), drawdown };
  });
  return { points, maxDrawdown, peakCumulativePnl: +peak.toFixed(2), finalCumulativePnl: +cum.toFixed(2) };
}

const ALL_METRICS = [
  'win_rate', 'profit_factor', 'avg_win', 'avg_loss', 'expectancy', 'max_drawdown',
  'avg_hold_days', 'trade_count', 'realized_pnl', 'total_fees', 'fee_drag_pct',
  'sharpe_ratio', 'sortino_ratio', 'roll_count',
];

/** Aggregate metrics over a set of *closed* positions (chains or equity
 *  lots — same shape). Each roll chain counts as ONE trade, not one per
 *  leg, which is the whole point of chaining them in buildOptionChains(). */
function computeMetricsFromPositions(closedPositions, dailyPnlSeries, opts = {}) {
  const priced = closedPositions.filter(p => p.net_pnl !== null);
  if (!priced.length) return { ok: false, reason: 'No closed positions with usable pricing matched those filters.' };

  const wanted = Array.isArray(opts.metrics) && opts.metrics.length && !opts.metrics.includes('all')
    ? new Set(opts.metrics) : new Set(ALL_METRICS);

  let totalGain = 0, totalLoss = 0, winCount = 0, lossCount = 0, totalFees = 0, holdDaysSum = 0, holdDaysN = 0, rollCount = 0;
  for (const p of priced) {
    if (p.net_pnl > 0) { totalGain += p.net_pnl; winCount++; } else { totalLoss += p.net_pnl; lossCount++; }
    totalFees += p.total_fees || 0;
    if (p.hold_days != null) { holdDaysSum += p.hold_days; holdDaysN++; }
    rollCount += p.roll_count || 0;
  }
  const tradeCount = priced.length;
  const realizedPnl = totalGain + totalLoss;
  const drawdown = computeDrawdown(dailyPnlSeries);

  const metrics = {};
  if (wanted.has('trade_count'))   metrics.trade_count = tradeCount;
  if (wanted.has('win_rate'))      metrics.win_rate = tradeCount ? +((winCount / tradeCount) * 100).toFixed(1) : 0;
  if (wanted.has('profit_factor')) metrics.profit_factor = totalLoss !== 0 ? +(totalGain / Math.abs(totalLoss)).toFixed(2) : 0;
  if (wanted.has('avg_win'))       metrics.avg_win = winCount ? +(totalGain / winCount).toFixed(2) : 0;
  if (wanted.has('avg_loss'))      metrics.avg_loss = lossCount ? +(totalLoss / lossCount).toFixed(2) : 0;
  if (wanted.has('expectancy'))    metrics.expectancy = +(realizedPnl / tradeCount).toFixed(2);
  if (wanted.has('max_drawdown'))  metrics.max_drawdown = drawdown.maxDrawdown;
  if (wanted.has('avg_hold_days')) metrics.avg_hold_days = holdDaysN ? +(holdDaysSum / holdDaysN).toFixed(1) : null;
  if (wanted.has('realized_pnl'))  metrics.realized_pnl = +realizedPnl.toFixed(2);
  if (wanted.has('total_fees'))    metrics.total_fees = +totalFees.toFixed(2);
  if (wanted.has('roll_count'))    metrics.roll_count = rollCount;
  if (wanted.has('fee_drag_pct')) {
    const grossMoved = totalGain + Math.abs(totalLoss);
    metrics.fee_drag_pct = grossMoved !== 0 ? +((totalFees / grossMoved) * 100).toFixed(2) : 0;
  }
  if (wanted.has('sharpe_ratio') || wanted.has('sortino_ratio')) {
    const dailyPnls = dailyPnlSeries.map(r => r.pnl);
    const dailyRf = (Number.isFinite(+opts.riskFreeRate) ? +opts.riskFreeRate : 0.05) / 252;
    const mean = dailyPnls.length ? dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length : 0;
    if (wanted.has('sharpe_ratio')) {
      const sd = _stdDev(dailyPnls);
      metrics.sharpe_ratio = sd > 0 ? +(((mean - dailyRf) / sd) * Math.sqrt(252)).toFixed(2) : 0;
    }
    if (wanted.has('sortino_ratio')) {
      const downsideSd = _stdDev(dailyPnls.filter(v => v < 0));
      metrics.sortino_ratio = downsideSd > 0 ? +(((mean - dailyRf) / downsideSd) * Math.sqrt(252)).toFixed(2) : 0;
    }
    metrics._caveat_ratios = 'sharpe_ratio/sortino_ratio are computed on the daily *dollar* P&L series (not % returns on a capital base), since this account has no clean starting-equity figure to normalize against — treat as a relative/comparative signal, not a textbook Sharpe.';
  }

  const excludedUnpriced = closedPositions.length - priced.length;
  const data = { metrics };
  if (excludedUnpriced > 0) {
    data.caveat = `${excludedUnpriced} closed position(s) were excluded — no usable cost-basis/pricing data in this dataset (see has_incomplete_pricing on get_positions).`;
  }
  return { ok: true, data };
}

module.exports = { buildOptionChains, buildEquityLots, buildPositions, computeDrawdown, computeMetricsFromPositions, ALL_METRICS };
