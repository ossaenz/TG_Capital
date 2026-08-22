/**
 * Confluence alert engine — a lighter-weight sibling to tradeIdeas.js.
 *
 * Instead of a full written report, this watches a user-managed watchlist and
 * fires an alert only when multiple signals line up in the same direction:
 *   - RSI oversold/overbought
 *   - MACD line crossing its signal line
 *   - ADX/DI confirming an actual trend (not just noise) in that direction
 *   - Volume spike vs. trailing average
 * All math reuses local/indicators.js (technicalindicators-backed, Wilder's
 * original smoothing throughout) — no hand-rolled math here, same discipline
 * as tradeIdeas.js.
 * Local-app-only: this file is never read by the static GitHub Pages app.
 */

const { computeRSI, computeMACD, computeADX } = require('./indicators.js');

const VOLUME_SPIKE_MULTIPLE = 1.8; // latest day's volume vs. trailing 20-day average
const CONFLUENCE_MIN_SIGNALS = 2;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const ADX_TRENDING = 20; // below this, ADX itself calls the trend too weak to confirm anything

function _macdCrossDirection(closes) {
  // Need two consecutive MACD readings to detect a cross on the most recent bar.
  const cur = computeMACD(closes);
  const prev = computeMACD(closes.slice(0, -1));
  if (!cur || !prev) return null;
  const curDiff = cur.macd - cur.signal;
  const prevDiff = prev.macd - prev.signal;
  if (prevDiff <= 0 && curDiff > 0) return 'bullish';
  if (prevDiff >= 0 && curDiff < 0) return 'bearish';
  return null;
}

function _volumeSpike(candles) {
  const vols = candles.map(c => Number(c.volume || 0)).filter(v => v > 0);
  if (vols.length < 21) return null;
  const latest = vols[vols.length - 1];
  const trailing = vols.slice(-21, -1); // 20 sessions before the latest
  const avg = trailing.reduce((a, b) => a + b, 0) / trailing.length;
  if (!avg) return null;
  const ratio = latest / avg;
  return ratio >= VOLUME_SPIKE_MULTIPLE ? { ratio: Number(ratio.toFixed(2)) } : null;
}

/**
 * candles: Schwab /pricehistory candles array (needs .close and .volume per bar).
 * sentiment: optional ADANOS sentiment object { score: 0-100, label: string, confidence: 0-1 }
 * Returns a confluence read for one ticker — never fetches anything itself,
 * matching the dependency-injection pattern used elsewhere (tradeIdeas.js,
 * portfolioRisk.js): callers pass in data already fetched via schwabMarket.
 */
function computeConfluence(symbol, candles, sentiment = null) {
  const closes = (candles || []).map(c => Number(c.close || 0)).filter(Boolean);
  if (closes.length < 36) {
    return { symbol, fires: false, signals: [], reason: 'Not enough price history (need 36+ daily bars for MACD)' };
  }

  const rsi14 = computeRSI(closes, 14);
  const macd = computeMACD(closes);
  const macdCross = _macdCrossDirection(closes);
  const volSpike = _volumeSpike(candles);
  const adx = computeADX(candles, 14);

  const signals = [];
  let bullish = 0, bearish = 0;

  if (rsi14 != null) {
    if (rsi14 < RSI_OVERSOLD) { signals.push(`RSI oversold (${rsi14})`); bullish++; }
    else if (rsi14 > RSI_OVERBOUGHT) { signals.push(`RSI overbought (${rsi14})`); bearish++; }
  }
  if (macdCross === 'bullish') { signals.push('MACD bullish crossover'); bullish++; }
  else if (macdCross === 'bearish') { signals.push('MACD bearish crossover'); bearish++; }

  const direction = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : null;
  let alignedCount = direction === 'bullish' ? bullish : direction === 'bearish' ? bearish : 0;

  // ADX/DI only counts as confirmation once RSI/MACD have already established
  // a direction, and only when ADX shows an actual trend (not chop) agreeing
  // with that direction — same standard reading used in _trendDirection.
  if (direction && adx && adx.adx >= ADX_TRENDING) {
    const adxDirection = adx.pdi > adx.mdi ? 'bullish' : 'bearish';
    if (adxDirection === direction) {
      signals.push(`ADX ${adx.adx} confirms ${direction} trend (+DI ${adx.pdi} / -DI ${adx.mdi})`);
      alignedCount++;
    }
  }

  // Volume itself isn't directional — it only counts toward confluence once a
  // direction is already established, as confirmation of conviction.
  if (volSpike && direction) {
    signals.push(`Volume ${volSpike.ratio}x trailing average`);
    alignedCount++;
  }

  // Sentiment is also a confirmation layer: bullish sentiment with bullish technicals
  // = higher conviction. Bearish sentiment + bullish technicals = caution flag but not
  // a counter-signal (misalignment just lowers confidence, doesn't flip direction).
  let sentimentAlignment = null;
  if (sentiment && sentiment.score != null && direction) {
    const sentimentLabel = sentiment.score > 70 ? 'bullish' : sentiment.score < 30 ? 'bearish' : 'neutral';
    const isAligned = sentimentLabel === direction;
    sentimentAlignment = { label: sentimentLabel, isAligned, confidence: sentiment.confidence };
    if (isAligned && sentiment.confidence > 0.6) {
      signals.push(`Sentiment ${sentimentLabel} (${Math.round(sentiment.score)}, conf: ${Math.round(sentiment.confidence * 100)}%)`);
      alignedCount++;
    } else if (!isAligned) {
      signals.push(`⚠ Sentiment ${sentimentLabel} — misaligned with ${direction} technicals`);
    }
  }

  return {
    symbol, rsi14, macd, macdCross, adx, volumeSpike: volSpike,
    sentiment: sentiment ? { score: sentiment.score, label: sentiment.label, alignment: sentimentAlignment } : null,
    direction, signals,
    fires: direction != null && alignedCount >= CONFLUENCE_MIN_SIGNALS,
  };
}

module.exports = { computeConfluence, CONFLUENCE_MIN_SIGNALS, VOLUME_SPIKE_MULTIPLE, RSI_OVERSOLD, RSI_OVERBOUGHT };
