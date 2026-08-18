/**
 * Finnhub company news — secondary/gap-fill news source alongside SEC filings
 * (primary, highest-trust event layer) and crawled web sentiment (lowest-trust,
 * no structured source). Tagged "API" in the UI so items can be visually
 * trust-ranked against those other two. Local-app-only, same as sectors.js.
 */

async function fetchFinnhubNews(ticker, apiKey, days = 7) {
  if (!apiKey) return { skipped: true, reason: 'no FINNHUB_API_KEY set' };
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const fmt = d => d.toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fmt(from)}&to=${fmt(to)}&token=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub news ${res.status} for ${ticker}`);
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

module.exports = { fetchFinnhubNews };
