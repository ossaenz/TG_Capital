/**
 * Sentiment crawler — auto-populates scout_sentiment from news crawlers + LM scoring
 */
const { scoreDocument } = require('./lmSentiment.js');
const { fetchFinnhubNews } = require('./news.js');

async function crawlSentimentForTicker(db, ticker, finnhubKey) {
  if (!finnhubKey) return 0;

  try {
    const news = await fetchFinnhubNews(ticker, finnhubKey, 7);
    if (!news.length) return 0;

    let inserted = 0;
    const now = new Date().toISOString();

    for (const item of news.slice(0, 3)) {
      if (!item.headline) continue;

      const text = `${item.headline} ${item.summary || ''}`;
      const scores = scoreDocument(text);
      const sentiment_score = scores.pss_0_100 || 50;
      const sentiment_label = sentiment_score > 60 ? 'bullish' : sentiment_score < 40 ? 'bearish' : 'neutral';
      const confidence = (scores.sentimentWords || 0) / Math.max(scores.totalWords, 1);

      db.prepare(`
        INSERT OR REPLACE INTO scout_sentiment
        (ticker, query, content, sentiment_score, sentiment_label, confidence, source, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ticker,
        item.headline,
        item.summary || '',
        sentiment_score,
        sentiment_label,
        Math.min(confidence, 0.99),
        'news-crawler',
        now
      );
      inserted++;
    }
    return inserted;
  } catch (err) {
    console.warn(`Sentiment crawl for ${ticker}:`, err.message);
    return 0;
  }
}

async function crawlAllWatchlist(db, finnhubKey) {
  const tickers = db.prepare(`SELECT ticker FROM scout_watchlist`).all().map(r => r.ticker);
  let total = 0;
  for (const ticker of tickers) {
    const count = await crawlSentimentForTicker(db, ticker, finnhubKey);
    total += count;
  }
  console.log(`✓ Crawled sentiment: ${total} items`);
  return total;
}

module.exports = { crawlSentimentForTicker, crawlAllWatchlist };
