let db = loadDB();

// ════════════════════════════════════════════════════════
// PARSING UTILITIES
// ════════════════════════════════════════════════════════

function parseMoney(s) {
  if (!s && s !== 0) return null;
  if (typeof s === 'number') return s;
  const clean = String(s).replace(/[$,\s]/g, '').trim();
  if (clean === '' || clean === '-') return null;
  return parseFloat(clean);
}

function parseDate(s) {
  if (!s) return null;
  // Handle "04/07/2026 as of 04/06/2026" — use settlement date (second)
  const asParts = String(s).match(/as of\s+(\d{2}\/\d{2}\/\d{4})/);
  const dateStr = asParts ? asParts[1] : String(s).trim();
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`; // ISO
}

function parseQty(s) {
  if (s === null || s === undefined || s === '') return null;
  const v = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(v) ? null : v;
}

// Parse Schwab option symbol: "SPY 04/09/2026 640.00 P"
function parseOptionSymbol(sym) {
  if (!sym) return null;
  const m = sym.trim().match(/^([A-Z0-9.]+)\s+(\d{2}\/\d{2}\/\d{4})\s+([\d.]+)\s+([CP])$/);
  if (!m) return null;
  return {
    underlying: m[1],
    expiry: parseDate(m[2]),
    strike: parseFloat(m[3]),
    optionType: m[4] === 'C' ? 'call' : 'put'
  };
}

const ETF_LIST = new Set([
  'SPY','QQQ','IWM','DIA','GLD','SLV','TLT','HYG','LQD','XLF','XLE','XLK','XLV','XLB',
  'XLP','XLI','XLY','XLU','XLRE','ARKK','ARKG','ARKQ','ARKF','ARKG','VTI','VOO','VEA',
  'VWO','VYM','VIG','VNQ','VGK','BND','AGG','EMB','SPLG','SPYM','TSLY','CONY','ULTY',
  'AMDY','NAIL','EWW','UWMC','BULL','JBLU',
]);

function classifyInstrument(sym, action) {
  if (!sym) return 'other';
  if (parseOptionSymbol(sym)) return 'option';
  if (ETF_LIST.has(sym.trim().toUpperCase())) return 'etf';
  return 'stock';
}

const RESERVED_ACTION_TOKENS = new Set([
  'BUY', 'SELL', 'BOT', 'SOLD', 'ASSIGNED', 'EXPIRED',
  'SELL TO OPEN', 'BUY TO CLOSE', 'BUY TO OPEN', 'SELL TO CLOSE',
]);

function normalizeAction(action) {
  return String(action || '').trim();
}

function sanitizeSymbol(rawSymbol, action) {
  const sym = String(rawSymbol || '').trim().toUpperCase();
  if (!sym) return '';
  if (RESERVED_ACTION_TOKENS.has(sym)) return '';

  const normalizedAction = normalizeAction(action).toUpperCase();
  if (normalizedAction === 'BOT' || normalizedAction === 'SOLD') return '';

  return sym;
}

function moneyKey(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  return Number(v).toFixed(4);
}

// Generate a stable row ID for deduplication
function rowId(t) {
  return [
    t.rawDate || '',
    t.date || '',
    normalizeAction(t.action),
    sanitizeSymbol(t.symbol, t.action),
    t.acctgRuleCd || '',
    t.quantity ?? '',
    moneyKey(t.price),
    moneyKey(t.fees),
    moneyKey(t.amount),
    String(t.description || '').trim(),
  ].join('|');
}

function sanitizeTransaction(rawTxn) {
  const t = Object.assign({}, rawTxn || {});
  t.action = normalizeAction(t.action);
  t.symbol = sanitizeSymbol(t.symbol, t.action);
  t.rawDate = (t.rawDate || '').trim();
  t.date = t.date || parseDate(t.rawDate) || null;
  t.quantity = t.quantity === '' ? null : t.quantity;
  t.price = t.price === '' ? null : t.price;
  t.fees = t.fees || 0;
  t.description = (t.description || '').trim();
  t.acctgRuleCd = t.acctgRuleCd == null ? '' : String(t.acctgRuleCd).trim();
  t.id = rowId(t);
  return t;
}

function dedupeTransactions(items) {
  const unique = [];
  const seen = new Set();
  for (const item of items || []) {
    const t = sanitizeTransaction(item);
    if (!t.action && !t.symbol) continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    unique.push(t);
  }
  unique.sort((a, b) => (b.date || b.rawDate || '').localeCompare(a.date || a.rawDate || ''));
  return unique;
}

function sanitizeDB(rawDB) {
  const next = Object.assign(createEmptyDB(), rawDB || {});
  next.transactions = dedupeTransactions(next.transactions || []);

  const seenBatch = new Set();
  next.importBatches = (next.importBatches || []).filter(b => {
    if (!b || !b.id || seenBatch.has(b.id)) return false;
    seenBatch.add(b.id);
    return true;
  });

  next.journalEntries = (next.journalEntries || []);
  next.version = 4;
  return next;
}

function mergeDatabases(localDB, remoteDB) {
  const left = sanitizeDB(localDB);
  const right = sanitizeDB(remoteDB);

  const merged = createEmptyDB();
  merged.transactions = dedupeTransactions([...(right.transactions || []), ...(left.transactions || [])]);

  const importBatches = [...(right.importBatches || []), ...(left.importBatches || [])];
  const seen = new Set();
  merged.importBatches = importBatches.filter(b => {
    if (!b || !b.id || seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });

  const journalEntries = [...(right.journalEntries || []), ...(left.journalEntries || [])];
  const seenJournal = new Set();
  merged.journalEntries = journalEntries.filter(j => {
    if (!j || !j.id || seenJournal.has(j.id)) return false;
    seenJournal.add(j.id);
    return true;
  });

  return merged;
}

// ════════════════════════════════════════════════════════
// CSV PARSER
// ════════════════════════════════════════════════════════
function parseCSV(text) {
  const lines = text.split('\n');
  const headerLine = lines.find(line => line.trim());
  if (!headerLine) return [];
  const headerIndex = lines.indexOf(headerLine);
  const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV parse (handles quoted commas for Schwab)
    const cells = [];
    let inQ = false, cur = '';
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function looksLikeFidelityAccountsHistory(rows) {
  if (!rows || rows.length === 0) return false;
  const headers = Object.keys(rows[0] || {}).map(h => h.trim().toLowerCase());
  return headers.includes('run date') && headers.includes('account number') && headers.includes('settlement date');
}

function normalizeFidelityAction(actionText) {
  const text = String(actionText || '').trim().toUpperCase();
  if (!text) return '';
  if (text.startsWith('YOU BOUGHT ')) return 'Buy';
  if (text.startsWith('YOU SOLD ')) return 'Sell';
  if (text.includes('DIVIDEND')) return 'Cash Dividend';
  if (text.includes('INTEREST')) return 'Credit Interest';
  if (text.includes('EXCHANGE IN')) return 'Exchange In';
  if (text.includes('EXCHANGE OUT')) return 'Exchange Out';
  return String(actionText || '').trim();
}

function parseFidelitySymbol(actionText, description, fallbackSymbol) {
  const raw = `${actionText || ''} ${description || ''}`.toUpperCase();
  const match = raw.match(/\(([A-Z0-9.\-]+)\)/);
  if (match && match[1]) return match[1].trim();
  return String(fallbackSymbol || '').trim().toUpperCase();
}

function fidelityRowsToCanonical(rows) {
  const out = [];
  for (const row of rows || []) {
    const actionText = row['Action'] || row.action || '';
    const action = normalizeFidelityAction(actionText);
    if (!action || action === 'Exchange In' || action === 'Exchange Out') continue;

    const runDate = row['Run Date'] || row['Date'] || row.date || '';
    const settlementDate = row['Settlement Date'] || row['Settlement'] || '';
    const description = (row['Description'] || row.description || '').trim();
    const symbol = parseFidelitySymbol(actionText, description, row['Symbol'] || row.symbol || '');
    const quantity = parseQty(row['Quantity'] ?? row.quantity ?? '');
    const price = parseMoney(row['Price ($)'] ?? row['Price'] ?? row.price ?? '');
    const commission = parseMoney(row['Commission ($)'] ?? row['Fees ($)'] ?? row['Fees & Comm'] ?? row.fees ?? '') || 0;
    const amount = parseMoney(row['Amount ($)'] ?? row['Amount'] ?? row.amount ?? '');

    if (!symbol && !/DIVIDEND|INTEREST/i.test(action)) continue;

    out.push({
      rawDate: String(runDate || settlementDate || '').trim(),
      date: parseDate(runDate) || parseDate(settlementDate) || null,
      action,
      symbol,
      description,
      quantity,
      price,
      fees: commission,
      amount,
      acctgRuleCd: (row['Type'] || row.type || '').trim(),
    });
  }
  return out;
}

function normalizeImportedCsvRows(fileName, rows) {
  if (looksLikeFidelityAccountsHistory(rows)) {
    addLog(`  → detected Fidelity accounts history; normalizing rows`, 'info');
    return fidelityRowsToCanonical(rows);
  }
  return rows;
}

function normalizeRow(raw, batchId) {
  const action = normalizeAction(raw['Action']);
  const symbol = sanitizeSymbol(raw['Symbol'], action);
  const optInfo = parseOptionSymbol(symbol);
  const inst = classifyInstrument(symbol, action);
  const qty = parseQty(raw['Quantity']);
  const price = parseMoney(raw['Price']);
  const fees = parseMoney(raw['Fees & Comm']);
  const amount = parseMoney(raw['Amount']);
  const rawDate = (raw['Date'] || '').trim();
  const date = parseDate(rawDate);

  let direction = null;
  if (['Sell to Open','Buy to Close','Buy to Open','Sell to Close'].includes(action)) {
    direction = ['Sell to Open','Sell to Close'].includes(action) ? 'short' : 'long';
  } else if (action === 'Buy') { direction = 'long'; }
  else if (action === 'Sell') { direction = 'short'; }

  const t = {
    rawDate, date, action, symbol, description: (raw['Description'] || '').trim(),
    quantity: qty, price, fees: fees || 0, amount,
    acctgRuleCd: (raw['AcctgRuleCd'] || '').trim(),
    instrument: inst,
    optionType: optInfo ? optInfo.optionType : null,
    underlying: optInfo ? optInfo.underlying : (inst !== 'option' ? symbol : null),
    strike: optInfo ? optInfo.strike : null,
    expiry: optInfo ? optInfo.expiry : null,
    direction,
    batchId,
  };
  return sanitizeTransaction(t);
}

function importRecords(rawRows, fileName, batchId) {
  db = sanitizeDB(db);
  const existingIds = new Set(db.transactions.map(t => t.id));
  let added = 0, dupes = 0;
  const newTxns = [];
  for (const raw of rawRows) {
    if (!raw['Action'] && !raw['Symbol']) continue;
    const t = normalizeRow(raw, batchId);
    if (!t.symbol && !t.action) continue;
    if (existingIds.has(t.id)) { dupes++; continue; }
    existingIds.add(t.id);
    newTxns.push(t);
    added++;
  }
  db.transactions.push(...newTxns);
  db.transactions = dedupeTransactions(db.transactions);

  // Create journal entries for trade transactions (actions that represent actual trades)
  const tradeActions = ['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close', 'Buy', 'Sell', 'Assigned', 'Expired'];
  for (const txn of newTxns) {
    if (tradeActions.includes(txn.action)) {
      const entry = {
        id: 'journal_' + txn.id,
        transactionId: txn.id,
        date: txn.date || txn.rawDate,
        symbol: txn.symbol,
        action: txn.action,
        quantity: txn.quantity,
        price: txn.price,
        underlying: txn.underlying,
        strike: txn.strike,
        expiry: txn.expiry,
        instrument: txn.instrument,
        strategy: '',
        notes: '',
        screenshots: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.journalEntries.push(entry);
    }
  }

  db.importBatches.push({ id: batchId, fileName, importedAt: new Date().toISOString(), total: rawRows.length, added, dupes });
  saveDB(db);
  return { added, dupes, total: rawRows.length };
}
