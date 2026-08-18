/**
 * Proactive Scout — trade-idea report generator.
 *
 * Design discipline (see PLAN_trade_ideas_and_analytics.md): every number in
 * the digest handed to the LLM is computed deterministically in this file or
 * by injected helpers from server.js — the LLM is only ever asked to rank
 * and narrate from data it's given, never to compute or invent a number.
 * This is decision support for manual review, not an autonomous trader and
 * not a price prediction.
 *
 * Local-app-only: this file is never read by the static GitHub Pages app.
 */

const { computeRSI, computeMACD, computeATR } = require('./indicators.js');

function _defaultWatchlist(db, limit = 6) {
  const rows = db.prepare(`
    SELECT COALESCE(underlying, symbol) as t, COUNT(*) as n
    FROM trades WHERE asset_type = 'OPTION' GROUP BY t ORDER BY n DESC LIMIT ?
  `).all(limit);
  const set = new Set(rows.map(r => r.t).filter(Boolean));
  set.add('SPY'); // always considered, per the user's stated wheel + SPY day/swing strategy
  return [...set];
}

async function _buildTickerDigest(symbol, helpers) {
  const {
    schwabMarket, computeDashboard, ragSearch,
    trendDirection, supportResistance, ivRankProxy, normalizeIvPct,
    nearestByDelta, chainLiquidityScore, pickExpiry, flattenChain,
  } = helpers;

  const [qData, hData, cData] = await Promise.all([
    schwabMarket('/quotes', { symbols: symbol, fields: 'quote' }),
    schwabMarket('/pricehistory', { symbol, periodType: 'month', period: 6, frequencyType: 'daily', frequency: 1 }),
    schwabMarket('/chains', { symbol, contractType: 'ALL', strikeCount: '10', includeUnderlyingQuote: 'true' }),
  ]);

  const spot = Number(qData?.[symbol]?.quote?.lastPrice ?? qData?.[symbol]?.quote?.mark ?? 0);
  const candles = hData?.candles || [];
  if (!spot || candles.length < 20) return null; // not enough data to say anything useful

  const trend = trendDirection(candles);
  const { support, resistance } = supportResistance(candles, spot);
  const ivPct = normalizeIvPct(cData?.volatility);
  const ivRank = ivRankProxy(ivPct, candles);

  const closes = candles.map(c => Number(c.close || 0)).filter(Boolean);
  const rsi14 = computeRSI(closes, 14);
  const macd = computeMACD(closes);
  const atr14 = computeATR(candles, 14); // real dollar-move volatility measure, for sizing/strike context

  const puts = flattenChain(cData?.putExpDateMap, 'PUT');
  const calls = flattenChain(cData?.callExpDateMap, 'CALL');
  const allLegs = [...puts, ...calls];
  const bestExpiry = pickExpiry(allLegs);
  const liquidityScore = chainLiquidityScore(allLegs);

  const shortPut = nearestByDelta(puts.filter(p => p.strike < spot), -0.20);
  const shortCall = nearestByDelta(calls.filter(c => c.strike > spot), 0.20);

  const own = computeDashboard(null, null, symbol);
  // Pure semantic search has no ticker awareness — a journal note about a totally
  // different ticker can rank highly just for sounding like similar options-strategy
  // language ("closed position... collect theta... short strike into expiry"). Pull a
  // larger candidate pool, then keep only journal entries whose own symbol/underlying
  // actually matches this ticker (rag_docs.metadata carries the source journal_entries
  // row, which has real symbol/underlying columns — just never checked here before).
  const ragPool = ragSearch ? await ragSearch(`${symbol} trade journal notes`, 20).catch(() => []) : [];
  const ragHits = (ragPool || []).filter(h => {
    if (h.source !== 'journal') return false;
    try {
      const meta = JSON.parse(h.metadata || '{}');
      const underlying = String(meta.underlying || '').toUpperCase();
      const metaSymbol = String(meta.symbol || '').toUpperCase();
      return underlying === symbol.toUpperCase() || metaSymbol.includes(symbol.toUpperCase());
    } catch { return false; }
  }).slice(0, 3);

  return {
    symbol, spot, trend, support, resistance, ivPct, ivRank,
    technicals: { rsi14, macd, atr14 },
    chainQuality: {
      liquidityScore: Number.isFinite(liquidityScore) ? Math.round(liquidityScore) : null,
      bestExpiry: bestExpiry?.expiry || null,
      dte: bestExpiry?.dte ?? null,
    },
    candidateStrikes: {
      shortPut: shortPut ? { strike: shortPut.strike, delta: shortPut.delta, mid: shortPut.mid, expiry: shortPut.expiry } : null,
      shortCall: shortCall ? { strike: shortCall.strike, delta: shortCall.delta, mid: shortCall.mid, expiry: shortCall.expiry } : null,
    },
    ownHistory: own ? {
      closedCount: own.stats.totalTrades, netPnL: own.stats.netPnL,
      winRate: own.stats.winRate, profitFactor: own.stats.profitFactor,
    } : null,
    ragNotes: (ragHits || []).map(h => (h.content || '').slice(0, 300)),
  };
}

const SYSTEM_PROMPT = [
  "You are Plutus, a trading research assistant helping the trader review candidate setups.",
  "You will be given a JSON digest with precomputed technical data, option-chain candidates, and",
  "the trader's own historical performance for a list of tickers. Every number in the digest is",
  "ALREADY CALCULATED — do not recompute, restate a rounded/altered version, or invent any number",
  "not present in the digest. If a field is null, say the data wasn't available rather than guessing.",
  "",
  "Your job: rank the tickers and write up the 2-3 most interesting candidates as a short markdown",
  "report. For each: name the setup (side/strike/expiry from candidateStrikes), the reasoning",
  "(trend/support-resistance/IV rank/RSI/MACD/ATR from technicals — atr14 is the average daily dollar",
  "range, useful context for how far a strike is in ATR terms, not just percent), and how the trader's own history on",
  "that ticker (ownHistory) supports or cautions against it — if ownHistory shows a losing track",
  "record on that ticker, say so explicitly rather than ignoring it.",
  "",
  "This is decision support for the trader's own manual review — it is NOT financial advice and NOT",
  "a price prediction. End the report with one sentence making that explicit.",
].join('\n');

async function _callOllamaOneShot(digest, { ollamaHost, chatModel, ollamaTimeoutMs }) {
  const body = {
    model: chatModel,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: "Here is today's digest:\n\n" + JSON.stringify(digest, null, 2) },
    ],
  };
  const r = await fetch(`${ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ollamaTimeoutMs || 300000),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const data = await r.json();
  return data?.message?.content || '(no response from model)';
}

/**
 * helpers bundles everything this module needs from server.js by reference —
 * nothing in server.js is modified or moved; these are just existing function
 * values passed in, same pattern as fetchChain in portfolioRisk.js.
 */
async function generateTradeIdeaReport({ tickers, trigger = 'manual' }, helpers) {
  const { db, schwabMarket, fetchLiveAccountSnapshot, buildTradingStyleProfile,
          ollamaHost, chatModel, ollamaTimeoutMs } = helpers;

  const symbols = (tickers && tickers.length ? tickers : _defaultWatchlist(db)).map(s => s.toUpperCase());

  let snapshot = null;
  try { snapshot = await fetchLiveAccountSnapshot(); } catch {}

  let vix = null;
  try {
    const vixData = await schwabMarket('/quotes', { symbols: '$VIX.X', fields: 'quote' });
    vix = vixData?.['$VIX.X']?.quote?.lastPrice ?? vixData?.['$VIX']?.quote?.lastPrice ?? null;
  } catch {}

  const tickerDigests = [];
  for (const symbol of symbols) {
    try {
      const d = await _buildTickerDigest(symbol, helpers);
      if (d) tickerDigests.push(d);
      else tickerDigests.push({ symbol, error: 'Not enough live price history to analyze' });
    } catch (e) {
      tickerDigests.push({ symbol, error: e.message });
    }
  }

  const digest = {
    asOf: new Date().toISOString(),
    account: snapshot ? {
      liquidationValue: snapshot.balances.liquidationValue,
      buyingPower: snapshot.balances.buyingPower,
      cashBalance: snapshot.balances.cashBalance,
      totalOpenPnl: snapshot.summary.totalOpenPnl,
      positionCount: snapshot.summary.positionCount,
    } : null,
    tradingStyle: buildTradingStyleProfile ? buildTradingStyleProfile() : null,
    marketRegime: { vix },
    tickers: tickerDigests,
  };

  let reportMd;
  try {
    reportMd = await _callOllamaOneShot(digest, { ollamaHost, chatModel, ollamaTimeoutMs });
  } catch (e) {
    reportMd = `_Could not reach Ollama at ${ollamaHost}: ${e.message}. The raw digest below is still available for manual review._`;
  }

  const info = db.prepare(`
    INSERT INTO trade_idea_reports (trigger, tickers, digest_json, report_md)
    VALUES (?, ?, ?, ?)
  `).run(trigger, JSON.stringify(symbols), JSON.stringify(digest), reportMd);

  return { id: info.lastInsertRowid, digest, reportMd };
}

module.exports = { generateTradeIdeaReport, _defaultWatchlist, _buildTickerDigest };
