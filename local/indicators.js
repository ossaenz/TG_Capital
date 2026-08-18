/**
 * RSI/MACD/ADX/ATR via the `technicalindicators` npm package — deliberately
 * not hand-rolled. All four use Wilder's original smoothing (confirmed by
 * reading the package source, not assumed) — the same convention TradingView,
 * ThinkorSwim, and most brokers chart, not a naive-SMA approximation some
 * libraries default to. The LLM in the trade-idea generator never computes
 * these itself; it only ever sees the final numbers produced here.
 * Local-app-only: this file is never read by the static GitHub Pages app.
 */
const { RSI, MACD, ADX, ATR } = require('technicalindicators');

function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  const result = RSI.calculate({ values: closes, period });
  if (!result.length) return null;
  return Number(result[result.length - 1].toFixed(2));
}

function computeMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slowPeriod + signalPeriod) return null;
  const result = MACD.calculate({
    values: closes, fastPeriod, slowPeriod, signalPeriod,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  if (!result.length) return null;
  const last = result[result.length - 1];
  if (last.MACD == null || last.signal == null || last.histogram == null) return null;
  return {
    macd: Number(last.MACD.toFixed(3)),
    signal: Number(last.signal.toFixed(3)),
    histogram: Number(last.histogram.toFixed(3)),
  };
}

// ADX/+DI/-DI — the standard trend-strength read (Wilder's original formula).
// Needs full OHLC, not just closes, unlike RSI/MACD.
function computeADX(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2) return null;
  const high  = candles.map(c => Number(c.high  || 0));
  const low   = candles.map(c => Number(c.low   || 0));
  const close = candles.map(c => Number(c.close || 0));
  const result = ADX.calculate({ high, low, close, period });
  if (!result.length) return null;
  const last = result[result.length - 1];
  if (last.adx == null || last.pdi == null || last.mdi == null) return null;
  return {
    adx: Number(last.adx.toFixed(2)),
    pdi: Number(last.pdi.toFixed(2)),
    mdi: Number(last.mdi.toFixed(2)),
  };
}

// Average True Range — Wilder's volatility measure, using full OHLC.
function computeATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const high  = candles.map(c => Number(c.high  || 0));
  const low   = candles.map(c => Number(c.low   || 0));
  const close = candles.map(c => Number(c.close || 0));
  const result = ATR.calculate({ high, low, close, period });
  if (!result.length) return null;
  return Number(result[result.length - 1].toFixed(3));
}

module.exports = { computeRSI, computeMACD, computeADX, computeATR };
