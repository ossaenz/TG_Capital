/**
 * Thin SQLite data-access layer for the Plutus AI chat layer's structured
 * tools — the counterpart to query_trades' raw-SQL escape hatch. This file
 * owns exactly one job: turn filter args into a SQL query, fetch plain
 * trade-row objects, and hand them to positionEngine.js (the actual "brain"
 * — pure functions, no DB knowledge). Keeping that split means the PnL/
 * roll-chain/FIFO logic can be unit-tested or ported without a database at
 * all; only this file would need to change for a different store.
 *
 * Every export resolves to { ok: true, data } or { ok: false, reason } —
 * never throws — so the tool-calling loop in server.js never breaks on a
 * bad filter or an empty result set.
 */

const engine = require('./positionEngine.js');

function _tradeFilterClause(args = {}, { includeDate = true } = {}) {
  const conds = [];
  const params = [];
  if (args.symbol) { conds.push('COALESCE(underlying, symbol) = ?'); params.push(String(args.symbol).toUpperCase()); }
  if (args.asset_type && args.asset_type !== 'ALL') { conds.push('asset_type = ?'); params.push(String(args.asset_type).toUpperCase()); }
  if (args.action) { conds.push('action = ?'); params.push(args.action); }
  if (includeDate && args.date_from) { conds.push('date_iso >= ?'); params.push(args.date_from); }
  if (includeDate && args.date_to)   { conds.push('date_iso <= ?'); params.push(args.date_to); }
  if (args.strategy) { conds.push('symbol IN (SELECT symbol FROM journal_entries WHERE strategy = ?)'); params.push(args.strategy); }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

function getTrades(db, args = {}) {
  try {
    const { where, params } = _tradeFilterClause(args);
    const sortMap = {
      date_asc: 'date_iso ASC, id ASC', date_desc: 'date_iso DESC, id DESC',
      amount_asc: 'amount ASC', amount_desc: 'amount DESC',
    };
    const orderBy = sortMap[args.sort] || sortMap.date_desc;
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));

    const totalMatching = db.prepare(`SELECT COUNT(*) as n FROM trades ${where}`).get(...params).n;
    const rows = db.prepare(`
      SELECT id, date_iso as date, action, symbol, underlying, asset_type, quantity, price, fees, amount
      FROM trades ${where} ORDER BY ${orderBy} LIMIT ?
    `).all(...params, limit);

    const truncated = totalMatching > rows.length;
    const data = { count: rows.length, total_matching: totalMatching, truncated, rows };
    if (truncated) data.note = `Only showing ${rows.length} of ${totalMatching} matching trades — do NOT sum/average amount across this partial list for a total; call compute_metrics for an accurate aggregate, or narrow your filters.`;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Fetch every OPTION/EQUITY trade row matching symbol/asset_type/strategy
 *  (deliberately NOT date-restricted — a roll chain or a FIFO equity lot
 *  can span outside a requested window, and truncating the raw rows would
 *  silently mis-price it). date_from/date_to are applied afterward, against
 *  each resulting position's `opened` date, same as the old behavior. */
function _fetchPositionTrades(db, args) {
  const { where, params } = _tradeFilterClause(args, { includeDate: false });
  return db.prepare(`
    SELECT id, date_iso as date, action, symbol, underlying, asset_type, quantity, price, fees, amount
    FROM trades ${where} ORDER BY date_iso ASC, id ASC
  `).all(...params);
}

function getPositions(db, args = {}) {
  try {
    const status = args.status || 'closed';
    const assetType = args.asset_type ? args.asset_type.toUpperCase() : 'OPTION';
    const trades = _fetchPositionTrades(db, args);
    const built = engine.buildPositions(trades, { assetType });

    let filtered = status === 'all' ? built : built.filter(p => p.status === status);
    if (args.date_from) filtered = filtered.filter(p => p.opened && p.opened >= args.date_from);
    if (args.date_to) filtered = filtered.filter(p => p.opened && p.opened <= args.date_to);
    filtered.sort((a, b) => (b.opened || '').localeCompare(a.opened || ''));

    const totalMatching = filtered.length;
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
    const positions = filtered.slice(0, limit);

    const data = { count: positions.length, total_matching: totalMatching, positions };
    if (totalMatching > positions.length) {
      data.note = `Only showing ${positions.length} of ${totalMatching} matching positions — each array entry is a SEPARATE position (its own is_roll/legs), not legs of one big position. Do NOT sum net_pnl across this partial list for a total; call compute_metrics for an accurate aggregate.`;
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function computeMetrics(db, args = {}) {
  try {
    const assetType = args.asset_type ? args.asset_type.toUpperCase() : 'OPTION';
    const trades = _fetchPositionTrades(db, args);
    const built = engine.buildPositions(trades, { assetType });

    let closed = built.filter(p => p.status === 'closed');
    if (args.date_from) closed = closed.filter(p => p.opened && p.opened >= args.date_from);
    if (args.date_to) closed = closed.filter(p => p.opened && p.opened <= args.date_to);
    if (!closed.length) return { ok: false, reason: 'No closed positions matched those filters.' };

    const { where, params } = _tradeFilterClause(args); // date-scoped, for the drawdown/sharpe series
    const dailyRows = db.prepare(`SELECT date_iso as date, SUM(amount) as pnl FROM trades ${where} GROUP BY date_iso ORDER BY date_iso`).all(...params);

    const result = engine.computeMetricsFromPositions(closed, dailyRows, {
      metrics: args.metrics, riskFreeRate: args.risk_free_rate,
    });
    if (!result.ok) return result;
    result.data.scope = { symbol: args.symbol || null, asset_type: assetType, strategy: args.strategy || null, date_from: args.date_from || null, date_to: args.date_to || null };
    return result;
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { getTrades, getPositions, computeMetrics };
