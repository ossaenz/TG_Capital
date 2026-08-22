/**
 * ADANOS Sentiment Integration — "The sentiment layer for markets"
 * Fetches market sentiment scores for tickers and stores them for dashboard analysis.
 * Provides aggregated sentiment data for tiles and historical tracking for trend charts.
 */

const https = require('https');

const ADANOS_BASE = 'https://api.adanos.ai/v1';

/**
 * Fetch sentiment score from ADANOS API for a single ticker.
 * Returns { sentiment_score: 0-100, sentiment_label: string, confidence: 0-1 }
 * or null if fetch fails.
 */
async function fetchAdanosSentiment(ticker, apiKey) {
  if (!apiKey) return null;

  try {
    const url = `${ADANOS_BASE}/sentiment/${encodeURIComponent(ticker)}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.warn(`ADANOS sentiment fetch failed for ${ticker}: ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Normalize ADANOS response to our schema
    return {
      sentiment_score: data.score ?? data.sentiment?.score ?? null,  // 0-100
      sentiment_label: data.label ?? data.sentiment?.label ?? 'neutral',  // bullish/neutral/bearish
      confidence: data.confidence ?? data.sentiment?.confidence ?? 0.5,  // 0-1
    };
  } catch (err) {
    console.warn(`ADANOS API error for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * Fetch and store sentiment for a single ticker. Returns true on success, false on failure.
 */
async function fetchAndStoreSentiment(db, ticker, apiKey, priceAtFetch = null) {
  const sentimentData = await fetchAdanosSentiment(ticker, apiKey);
  if (!sentimentData) return false;

  try {
    const stmt = db.prepare(`
      INSERT INTO scout_sentiment (ticker, query, content, sentiment_score, sentiment_label, confidence, source, price_at_fetch, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, 'adanos', ?, datetime('now'))
    `);

    stmt.run(
      ticker,
      null,  // query field (not used for ADANOS)
      null,  // content field (not used for ADANOS)
      sentimentData.sentiment_score,
      sentimentData.sentiment_label,
      sentimentData.confidence,
      priceAtFetch
    );

    return true;
  } catch (err) {
    console.warn(`Failed to store sentiment for ${ticker}:`, err.message);
    return false;
  }
}

/**
 * Get the most recent sentiment data for a ticker.
 */
function getLatestSentiment(db, ticker) {
  return db.prepare(`
    SELECT * FROM scout_sentiment
    WHERE ticker = ? AND source = 'adanos' AND sentiment_score IS NOT NULL
    ORDER BY fetched_at DESC
    LIMIT 1
  `).get(ticker);
}

/**
 * Get sentiment history (time series) for a ticker. Returns last N records.
 */
function getSentimentHistory(db, ticker, limit = 30) {
  return db.prepare(`
    SELECT ticker, sentiment_score, sentiment_label, confidence, price_at_fetch, fetched_at
    FROM scout_sentiment
    WHERE ticker = ? AND source = 'adanos' AND sentiment_score IS NOT NULL
    ORDER BY fetched_at DESC
    LIMIT ?
  `).all(ticker, limit);
}

/**
 * Detect sentiment flips (bullish→bearish or vice versa) for alert purposes.
 * Returns { ticker, was_label, now_label, strength_change } or null.
 */
function detectSentimentFlip(db, ticker) {
  const rows = db.prepare(`
    SELECT sentiment_label, sentiment_score, fetched_at
    FROM scout_sentiment
    WHERE ticker = ? AND source = 'adanos' AND sentiment_score IS NOT NULL
    ORDER BY fetched_at DESC
    LIMIT 2
  `).all(ticker);

  if (rows.length < 2) return null;

  const [now, was] = rows;
  const isFlip =
    (was.sentiment_label === 'bullish' && now.sentiment_label === 'bearish') ||
    (was.sentiment_label === 'bearish' && now.sentiment_label === 'bullish');

  if (isFlip) {
    return {
      ticker,
      was_label: was.sentiment_label,
      now_label: now.sentiment_label,
      was_score: was.sentiment_score,
      now_score: now.sentiment_score,
      was_time: was.fetched_at,
      now_time: now.fetched_at,
    };
  }

  return null;
}

/**
 * Aggregate sentiment across multiple tickers (for heatmap).
 * Returns array of { ticker, sentiment_score, sentiment_label, confidence }.
 */
function getWatchlistSentiment(db, tickers) {
  if (tickers.length === 0) return [];

  const placeholders = tickers.map(() => '?').join(',');
  const query = `
    SELECT DISTINCT ON (ticker) ticker, sentiment_score, sentiment_label, confidence, fetched_at
    FROM scout_sentiment
    WHERE ticker IN (${placeholders}) AND source = 'adanos' AND sentiment_score IS NOT NULL
    ORDER BY ticker, fetched_at DESC
  `;

  try {
    return db.prepare(query).all(...tickers);
  } catch (err) {
    console.warn('Watchlist sentiment query failed:', err.message);
    return [];
  }
}

/**
 * Aggregate sentiment by sector. Returns { sector, avg_score, label_count }.
 */
function getSectorSentiment(db) {
  const query = `
    SELECT
      sc.sector,
      AVG(ss.sentiment_score) as avg_score,
      COUNT(CASE WHEN ss.sentiment_label = 'bullish' THEN 1 END) as bullish_count,
      COUNT(CASE WHEN ss.sentiment_label = 'neutral' THEN 1 END) as neutral_count,
      COUNT(CASE WHEN ss.sentiment_label = 'bearish' THEN 1 END) as bearish_count
    FROM scout_sentiment ss
    JOIN sector_cache sc ON ss.ticker = sc.symbol
    WHERE ss.source = 'adanos' AND ss.sentiment_score IS NOT NULL
      AND ss.fetched_at >= datetime('now', '-1 day')
    GROUP BY sc.sector
    ORDER BY avg_score DESC
  `;

  try {
    return db.prepare(query).all();
  } catch (err) {
    console.warn('Sector sentiment query failed:', err.message);
    return [];
  }
}

module.exports = {
  fetchAdanosSentiment,
  fetchAndStoreSentiment,
  getLatestSentiment,
  getSentimentHistory,
  detectSentimentFlip,
  getWatchlistSentiment,
  getSectorSentiment,
};
