/**
 * Risk Thermometer — margin/leverage usage gauge.
 * Local-app-only: this file is never read by the static GitHub Pages app.
 */

// Configurable bands — tweak these thresholds without touching the calling code.
const BANDS = {
  GREEN:  { max: 0.25, label: 'GREEN',  message: 'Safe: margin usage is conservative.' },
  YELLOW: { max: 0.50, label: 'YELLOW', message: "Warning: you're pushing leverage, consider reducing size." },
  RED:    { max: Infinity, label: 'RED', message: 'Danger: extreme margin usage. Consider closing positions to reduce risk.' },
};

/**
 * balances is fetchLiveAccountSnapshot().balances — { marginBalance, equity,
 * buyingPower, liquidationValue, cashBalance }.
 *
 * Ratio = |marginBalance| / equity when marginBalance is negative (funds
 * actually borrowed on margin) — a direct measure, not a proxy. Verified against
 * a real live Schwab snapshot: marginBalance (-$12,038.44) matched the account's
 * actual negative cash balance exactly.
 *
 * The previous formula — 1 - (buyingPower / equity) — was checked in unverified
 * (the file said so) and turned out to be structurally broken: Schwab's
 * buyingPower is LEVERAGED and routinely exceeds equity for any real margin
 * account, which makes "1 - buyingPower/equity" negative and therefore always
 * clamped to 0 regardless of actual margin usage — confirmed against that same
 * real snapshot (buyingPower $360,673.72 > equity $224,209.34), which is why the
 * gauge showed 0% while the account had real margin drawn. Falls back to that
 * buyingPower heuristic only when marginBalance reads exactly 0 (some account
 * types don't populate it) — and only when buyingPower <= equity, since above
 * that the heuristic is meaningless and returning 0 (unknown) is more honest
 * than a fabricated-looking number.
 */
function computeMarginRatio(balances) {
  const equity = balances?.equity || balances?.liquidationValue || 0;
  if (equity <= 0) return { ratio: 0, band: 'GREEN', message: BANDS.GREEN.message };

  const marginBalance = balances?.marginBalance || 0;
  let ratio;
  if (marginBalance < 0) {
    ratio = Math.max(0, Math.min(1, Math.abs(marginBalance) / equity));
  } else {
    const buyingPower = balances?.buyingPower || 0;
    ratio = (buyingPower > 0 && buyingPower <= equity) ? Math.max(0, Math.min(1, 1 - (buyingPower / equity))) : 0;
  }
  const band = ratio < BANDS.GREEN.max ? 'GREEN' : ratio < BANDS.YELLOW.max ? 'YELLOW' : 'RED';
  return { ratio, band, message: BANDS[band].message };
}

function snapshotRiskRatio(db, balances) {
  const { ratio } = computeMarginRatio(balances);
  // One row per day — REPLACE so re-syncing the same day just updates the
  // snapshot instead of piling up duplicate points on the sparkline.
  db.prepare(`
    INSERT OR REPLACE INTO risk_snapshots (date_iso, ratio, equity, buying_power, margin_balance)
    VALUES (date('now'), ?, ?, ?, ?)
  `).run(ratio, balances?.liquidationValue || 0, balances?.buyingPower || 0, balances?.marginBalance || 0);
}

function getRiskHistory(db, days = 30) {
  return db.prepare(`
    SELECT date_iso, ratio, equity, buying_power, margin_balance
    FROM risk_snapshots ORDER BY date_iso DESC LIMIT ?
  `).all(days).reverse();
}

module.exports = { computeMarginRatio, snapshotRiskRatio, getRiskHistory, BANDS };
