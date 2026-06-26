'use strict';
/**
 * RAG (Retrieval-Augmented Generation) module for TG-Capital local server.
 * Uses Ollama embeddings for semantic search over trades + journal entries.
 * Falls back to keyword matching when no embedding model is available.
 *
 * Uses Node 22 built-in fetch (not node-fetch) — node-fetch v2 throws
 * "Premature close" when reading Ollama's streaming response body.
 */

// ── DB init ───────────────────────────────────────────────────────────────────
function initRag(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_docs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source     TEXT NOT NULL,
      ref_id     TEXT NOT NULL,
      content    TEXT NOT NULL,
      metadata   TEXT DEFAULT '{}',
      embedding  TEXT,
      indexed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source, ref_id) ON CONFLICT REPLACE
    );
    CREATE INDEX IF NOT EXISTS idx_rag_source ON rag_docs(source);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id   TEXT UNIQUE,
      date_iso   TEXT,
      symbol     TEXT,
      underlying TEXT,
      action     TEXT,
      strategy   TEXT,
      notes      TEXT DEFAULT '',
      metadata   TEXT DEFAULT '{}',
      saved_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(date_iso);
  `);
}

// ── Embedding via Ollama ──────────────────────────────────────────────────────
async function embed(text, ollamaHost, model) {
  const r = await fetch(`${ollamaHost}/api/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model, prompt: text }),
    signal:  AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`Embedding HTTP ${r.status}`);
  const { embedding } = await r.json();
  if (!Array.isArray(embedding) || !embedding.length) throw new Error('Empty embedding');
  return embedding;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── Document builders ─────────────────────────────────────────────────────────
function positionToText(pos) {
  const pnl     = parseFloat(pos.net_pnl) || 0;
  const outcome = pnl >= 0 ? 'WIN' : 'LOSS';
  const ticker  = pos.underlying || pos.symbol;
  const legs    = (pos.actions  || '').split(',').map(s => s.trim()).filter(Boolean).join(', ');
  const lines   = [
    `${outcome}: ${ticker} options position`,
    `Contract: ${pos.symbol}`,
    `Opened: ${pos.opened || '?'}  Closed: ${pos.closed || '?'}`,
    `Actions: ${legs}`,
    `Net P&L: $${pnl.toFixed(2)}`,
  ];
  if (pos.total_fees) lines.push(`Fees: $${parseFloat(pos.total_fees).toFixed(2)}`);
  return lines.join('\n');
}

function journalEntryToText(e) {
  const parts = [`Journal [${e.date_iso || e.date || '?'}]`];
  if (e.underlying || e.symbol) parts[0] += ` — ${e.underlying || ''}${e.symbol ? ' (' + e.symbol + ')' : ''}`;
  if (e.action)   parts.push(`Action: ${e.action}`);
  if (e.strategy) parts.push(`Strategy: ${e.strategy}`);
  if (e.notes)    parts.push(`Notes: ${e.notes}`);
  return parts.join('\n');
}

// ── Indexing ──────────────────────────────────────────────────────────────────
let indexState = { running: false, progress: 0, total: 0, done: 0, error: null, lastRun: null };

function getIndexState() { return { ...indexState }; }

async function indexAll(db, ollamaHost, embedModel) {
  if (indexState.running) return { error: 'Already indexing' };
  indexState = { running: true, progress: 0, total: 0, done: 0, error: null, lastRun: null };

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO rag_docs (source, ref_id, content, metadata, embedding)
    VALUES (?, ?, ?, ?, ?)
  `);

  try {
    // Remove stale summary docs from previous runs (schema changes may rename ref_ids)
    db.prepare("DELETE FROM rag_docs WHERE source='summary'").run();
    // ── 1. Closed options positions ──────────────────────────────────────────
    const positions = db.prepare(`
      SELECT symbol, underlying, asset_type,
             SUM(amount) as net_pnl, SUM(fees) as total_fees,
             MIN(date_iso) as opened, MAX(date_iso) as closed,
             GROUP_CONCAT(DISTINCT action) as actions, COUNT(*) as legs
      FROM trades WHERE asset_type = 'OPTION'
      GROUP BY symbol
    `).all();

    // ── 2. Daily summaries ────────────────────────────────────────────────────
    const daily = db.prepare(`
      SELECT date_iso,
             SUM(amount) as pnl, COUNT(*) as count,
             GROUP_CONCAT(DISTINCT COALESCE(underlying, symbol)) as tickers
      FROM trades GROUP BY date_iso ORDER BY date_iso
    `).all();

    // ── 3. Monthly summaries (with wins/losses/tickers) ──────────────────────
    const monthly = db.prepare(`
      SELECT substr(date_iso,1,7) as month,
             SUM(amount) as pnl, COUNT(*) as count,
             GROUP_CONCAT(DISTINCT COALESCE(underlying,symbol)) as tickers,
             SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) as wins,
             SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) as losses
      FROM trades WHERE asset_type = 'OPTION'
      GROUP BY month ORDER BY pnl DESC
    `).all();

    // ── 4. Journal entries ────────────────────────────────────────────────────
    const journal = db.prepare('SELECT * FROM journal_entries').all();

    // ── 5. Top underlying tickers by activity ────────────────────────────────
    const topTickers = db.prepare(`
      SELECT COALESCE(underlying, symbol) as ticker,
             COUNT(DISTINCT symbol) as contracts,
             COUNT(*) as transactions,
             SUM(amount) as net_pnl,
             SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) as wins,
             SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) as losses
      FROM trades WHERE asset_type = 'OPTION'
      GROUP BY ticker ORDER BY transactions DESC LIMIT 30
    `).all();

    // ── 6. Overall account summary ───────────────────────────────────────────
    const overall = db.prepare(`
      SELECT COUNT(DISTINCT symbol) as contracts,
             COUNT(*) as transactions,
             SUM(amount) as total_pnl,
             MIN(date_iso) as first_trade,
             MAX(date_iso) as last_trade,
             SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) as wins,
             SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) as losses,
             SUM(fees) as total_fees
      FROM trades WHERE asset_type = 'OPTION'
    `).get();

    // Keep summary chunks under ~1200 chars to fit mxbai-embed-large context window
    const overallText = [
      'ACCOUNT OVERVIEW (options trading history):',
      `Total P&L: $${(overall.total_pnl||0).toFixed(2)}`,
      `Total transactions: ${overall.transactions} across ${overall.contracts} unique option contracts`,
      `Win/Loss: ${overall.wins} wins, ${overall.losses} losses (win rate: ${overall.transactions ? Math.round(overall.wins/overall.transactions*100) : 0}%)`,
      `Trading period: ${overall.first_trade} to ${overall.last_trade}`,
      `Total fees paid: $${(overall.total_fees||0).toFixed(2)}`,
    ].join('\n');

    // Split top tickers into two chunks of 15 each (stay within context window)
    const tickerDocs = [];
    for (let i = 0; i < topTickers.length; i += 15) {
      const chunk = topTickers.slice(i, i + 15);
      const rank  = i + 1;
      tickerDocs.push({
        src: 'summary',
        id:  `top-tickers-${rank}`,
        text: `TOP TRADED UNDERLYINGS (rank ${rank}–${rank+chunk.length-1} by transaction count):\n` +
              chunk.map((t, j) =>
                `#${i+j+1}: ${t.ticker} — ${t.transactions} tx, ${t.contracts} contracts, P&L $${(t.net_pnl||0).toFixed(2)}, ${t.wins}W/${t.losses}L`
              ).join('\n'),
        meta: { topTickers: chunk },
      });
    }

    // Monthly ranking split: best months and worst months
    const bestMonths  = monthly.slice(0, Math.ceil(monthly.length / 2));
    const worstMonths = monthly.slice(Math.ceil(monthly.length / 2));
    const monthRankDocs = [
      { id: 'monthly-best',  label: 'BEST MONTHS BY P&L',  rows: bestMonths  },
      { id: 'monthly-worst', label: 'WORST MONTHS BY P&L', rows: worstMonths },
    ].filter(g => g.rows.length).map(g => ({
      src: 'summary',
      id:  g.id,
      text: `${g.label}:\n` + g.rows.map(m =>
        `${m.month}: $${(m.pnl||0).toFixed(2)} (${m.wins}W/${m.losses}L) — ${m.tickers||'?'}`
      ).join('\n'),
      meta: {},
    }));

    const docs = [
      ...positions.map(p  => ({ src: 'trade',   id: p.symbol,   text: positionToText(p),    meta: p   })),
      ...daily.map(d      => ({ src: 'daily',    id: d.date_iso, text: `Trading day ${d.date_iso}: ${d.count} transactions on ${d.tickers || '?'}. Net P&L: $${(d.pnl||0).toFixed(2)}`, meta: d })),
      ...monthly.map(m    => ({ src: 'monthly',  id: m.month,    text: `Month ${m.month}: ${m.count} options transactions. Net P&L: $${(m.pnl||0).toFixed(2)}. ${m.wins||0}W/${m.losses||0}L. Tickers: ${m.tickers||'?'}`, meta: m })),
      ...journal.map(j    => ({ src: 'journal',  id: j.entry_id, text: journalEntryToText(j), meta: j  })),
      { src: 'summary', id: 'overall', text: overallText, meta: overall },
      ...tickerDocs,
      ...monthRankDocs,
    ];

    indexState.total = docs.length;

    for (const doc of docs) {
      let embedding = null;
      try {
        embedding = JSON.stringify(await embed(doc.text, ollamaHost, embedModel));
      } catch {}
      upsert.run(doc.src, doc.id, doc.text, JSON.stringify(doc.meta), embedding);
      indexState.done++;
      indexState.progress = Math.round(indexState.done / indexState.total * 100);
    }

    indexState.running = false;
    indexState.lastRun = new Date().toISOString();
    return { ok: true, indexed: indexState.done, total: indexState.total };
  } catch (err) {
    indexState.running = false;
    indexState.error   = err.message;
    return { error: err.message };
  }
}

// ── Upsert journal entries from browser ───────────────────────────────────────
function saveJournalEntries(db, entries) {
  const upsertJ = db.prepare(`
    INSERT OR REPLACE INTO journal_entries
      (entry_id, date_iso, symbol, underlying, action, strategy, notes, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => { for (const r of rows) upsertJ.run(r); });

  // Normalize date MM/DD/YYYY → YYYY-MM-DD
  function toISO(d) {
    if (!d) return null;
    if (/^\d{4}-/.test(d)) return d.slice(0, 10);
    const [m, day, y] = d.split('/');
    return y ? `${y}-${m.padStart(2,'0')}-${day.padStart(2,'0')}` : null;
  }

  const rows = entries
    .filter(e => e && (e.id || e.transactionId))
    .map(e => [
      e.id || e.transactionId,
      toISO(e.date),
      e.symbol      || null,
      e.underlying  || null,
      e.action      || null,
      e.strategy    || null,
      e.notes       || '',
      JSON.stringify(e),
    ]);

  insertMany(rows);
  return rows.length;
}

// ── Semantic search ───────────────────────────────────────────────────────────
async function search(db, query, ollamaHost, embedModel, topN = 6) {
  const allDocs = db.prepare('SELECT source, ref_id, content, metadata, embedding FROM rag_docs').all();
  if (!allDocs.length) return [];

  // Try embedding-based search
  let queryEmb = null;
  try { queryEmb = await embed(query, ollamaHost, embedModel); } catch {}

  if (queryEmb) {
    const scored = allDocs
      .filter(d => d.embedding)
      .map(d => ({ ...d, score: cosineSim(queryEmb, JSON.parse(d.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    if (scored.length) return scored;
  }

  // Keyword fallback
  const kws = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  return allDocs
    .map(d => ({ ...d, score: kws.reduce((s, kw) => s + (d.content.toLowerCase().includes(kw) ? 1 : 0), 0) }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

function buildContext(results) {
  return results
    .map((r, i) => `[${i+1}] (${r.source})\n${r.content}`)
    .join('\n\n---\n\n');
}

// ── Status ────────────────────────────────────────────────────────────────────
function getStatus(db) {
  const total   = db.prepare('SELECT COUNT(*) as n FROM rag_docs').get().n;
  const withEmb = db.prepare("SELECT COUNT(*) as n FROM rag_docs WHERE embedding IS NOT NULL").get().n;
  const sources = db.prepare('SELECT source, COUNT(*) as n FROM rag_docs GROUP BY source').all();
  const journal = db.prepare('SELECT COUNT(*) as n FROM journal_entries').get().n;
  return { total, withEmbeddings: withEmb, sources, journalEntries: journal, indexState };
}

module.exports = { initRag, indexAll, saveJournalEntries, search, buildContext, getStatus, getIndexState };
