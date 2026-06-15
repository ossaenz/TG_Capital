// ════════════════════════════════════════════════════════
// TRADING JOURNAL
// ════════════════════════════════════════════════════════
let currentJournalEntry = null;
let journalChartInstance = null;

function inferStrategy(entry) {
  const action = entry.action || '';
  const opt = (entry.optionType || '').toLowerCase();
  switch (action) {
    case 'Sell to Open':   return opt === 'put' ? 'Cash-Secured Put'  : opt === 'call' ? 'Covered Call' : null;
    case 'Buy to Close':   return opt === 'put' ? 'Cash-Secured Put'  : opt === 'call' ? 'Covered Call' : null;
    case 'Expired':        return opt === 'put' ? 'Cash-Secured Put'  : opt === 'call' ? 'Covered Call' : null;
    case 'Buy to Open':    return opt === 'put' ? 'Long Put'          : opt === 'call' ? 'Long Call'    : null;
    case 'Sell to Close':  return opt === 'put' ? 'Long Put'          : opt === 'call' ? 'Long Call'    : null;
    case 'Assigned':       return 'Wheel Strategy';
    case 'Buy':            return 'Stock Buy';
    case 'Sell':           return 'Stock Sale';
    default:               return null;
  }
}

function renderJournal() {
  // Silently backfill strategy on any entry that doesn't have one yet
  let backfilled = 0;
  for (const e of db.journalEntries) {
    if (!e.strategy) {
      const s = inferStrategy(e);
      if (s) { e.strategy = s; backfilled++; }
    }
  }
  if (backfilled > 0) saveDB(db);

  const search = (document.getElementById('journalSearch')?.value || '').toLowerCase();
  const dateStart = document.getElementById('journalDateStart')?.value || '';
  const dateEnd = document.getElementById('journalDateEnd')?.value || '';
  const strategyFilter = document.getElementById('journalStrategyFilter')?.value || '';
  const sortBy = document.getElementById('journalSort')?.value || 'date-desc';

  let filtered = db.journalEntries.filter(e => {
    const date = e.date || '';
    if (dateStart && date < dateStart) return false;
    if (dateEnd && date > dateEnd) return false;
    if (search && !e.symbol.toLowerCase().includes(search) && !e.action.toLowerCase().includes(search)) return false;
    if (strategyFilter) {
      const entryStrategy = e.strategy || 'Unassigned';
      if (entryStrategy !== strategyFilter) return false;
    }
    return true;
  });

  // Sort
  if (sortBy === 'date-desc') {
    filtered.sort((a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || ''));
  } else if (sortBy === 'date-asc') {
    filtered.sort((a, b) => (a.date || a.createdAt || '').localeCompare(b.date || b.createdAt || ''));
  } else if (sortBy === 'ticker') {
    filtered.sort((a, b) => ((a.underlying || a.symbol) || '').localeCompare((b.underlying || b.symbol) || ''));
  } else if (sortBy === 'strategy') {
    filtered.sort((a, b) => ((a.strategy || 'Unassigned') || '').localeCompare((b.strategy || 'Unassigned') || ''));
  }

  const container = document.getElementById('journalContainer');
  if (filtered.length === 0) {
    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text2);padding:40px;">No journal entries found.</div>';
    return;
  }

  container.innerHTML = filtered.map(entry => {
    const date = entry.date || 'N/A';
    const priceStr = entry.price ? '$' + entry.price.toFixed(2) : '—';
    const symbol = entry.underlying || entry.symbol;
    const actionStr = entry.action === 'Buy to Open' ? 'BTO' : entry.action === 'Sell to Open' ? 'STO' :
                      entry.action === 'Buy to Close' ? 'BTC' : entry.action === 'Sell to Close' ? 'STC' : entry.action;

    return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:16px;cursor:pointer;transition:all 0.2s;" onclick="openJournalEntry('${entry.id}')" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-family:var(--mono);font-weight:700;font-size:14px;color:var(--accent);">${symbol}</div>
        ${entry.strategy ? `<div style="background:var(--accent-dim);color:var(--accent);padding:3px 8px;border-radius:3px;font-size:10px;font-weight:700;">${entry.strategy}</div>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:var(--text1);margin-bottom:12px;">
        <div><span style="color:var(--text2);">Date:</span> ${date}</div>
        <div><span style="color:var(--text2);">Action:</span> ${actionStr}</div>
        <div><span style="color:var(--text2);">Qty:</span> ${entry.quantity}</div>
        <div><span style="color:var(--text2);">Price:</span> ${priceStr}</div>
      </div>
      <div style="font-size:11px;color:var(--text2);line-height:1.4;max-height:60px;overflow:hidden;text-overflow:ellipsis;">
        ${entry.notes || '<em style="opacity:0.6;">No notes yet — click to add</em>'}
      </div>
      ${entry.screenshots && entry.screenshots.length > 0 ? `<div style="margin-top:8px;font-size:11px;color:var(--accent);">📸 ${entry.screenshots.length} screenshot(s)</div>` : ''}
    </div>`;
  }).join('');
}

function openJournalEntry(entryId) {
  currentJournalEntry = db.journalEntries.find(e => e.id === entryId);
  if (!currentJournalEntry) return;

  document.getElementById('journalNotes').value = currentJournalEntry.notes || '';
  const strategySelect = document.getElementById('journalStrategy');
  const customInput = document.getElementById('journalStrategyCustom');

  const strategyToShow = currentJournalEntry.strategy || inferStrategy(currentJournalEntry) || '';
  const predefined = ['Iron Condor', 'Vertical Call Spread', 'Vertical Put Spread', 'Covered Call', 'Cash-Secured Put', 'Long Call', 'Long Put', 'Strangle', 'Straddle', 'Wheel Strategy', 'Stock Buy', 'Stock Sale'];
  if (strategyToShow && predefined.includes(strategyToShow)) {
    strategySelect.value = strategyToShow;
    customInput.style.display = 'none';
  } else if (strategyToShow) {
    strategySelect.value = 'Other';
    customInput.value = strategyToShow;
    customInput.style.display = 'block';
  } else {
    strategySelect.value = '';
    customInput.style.display = 'none';
  }

  updateJournalSummary();
  renderJournalScreenshots();
  fetchAndRenderPriceChart();
  document.getElementById('journalModal').style.display = 'block';
  document.addEventListener('paste', handleJournalPaste);
}

function closeJournalModal() {
  document.getElementById('journalModal').style.display = 'none';
  document.removeEventListener('paste', handleJournalPaste);
  currentJournalEntry = null;
}

function updateJournalSummary() {
  if (!currentJournalEntry) return;
  const e = currentJournalEntry;
  const symbol = e.underlying || e.symbol;
  const strikeExp = e.strike ? ` ${e.strike}${e.expiry ? ' exp ' + e.expiry : ''}` : '';
  const summary = `
    <div style="margin-bottom:12px;"><strong>${symbol}${strikeExp}</strong></div>
    <div><strong>Action:</strong> ${e.action}</div>
    <div><strong>Quantity:</strong> ${e.quantity}</div>
    <div><strong>Price:</strong> $${(e.price || 0).toFixed(2)}</div>
    <div><strong>Date:</strong> ${e.date}</div>
    <div><strong>Total Value:</strong> $${((e.quantity || 0) * (e.price || 0)).toFixed(2)}</div>
  `;
  document.getElementById('journalSummary').innerHTML = summary;
}

function renderJournalScreenshots() {
  if (!currentJournalEntry) return;
  const preview = document.getElementById('journalImagePreview');
  const screenshots = currentJournalEntry.screenshots || [];

  if (screenshots.length === 0) {
    preview.innerHTML = '';
    return;
  }

  preview.innerHTML = screenshots.map((img, idx) => `
    <div style="position:relative;width:80px;height:80px;">
      <img src="${img}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;border:1px solid var(--border);" />
      <button onclick="removeJournalScreenshot(${idx})" style="position:absolute;top:-8px;right:-8px;width:24px;height:24px;border-radius:50%;background:var(--red);color:#fff;border:none;cursor:pointer;font-size:12px;">×</button>
    </div>
  `).join('');
}

function handleJournalImageUpload(event) {
  const files = event.target.files;
  if (!files || !currentJournalEntry) return;

  addJournalScreenshotsFromFiles(files);
  event.target.value = '';
}

function addJournalScreenshotsFromFiles(files) {
  if (!files || !currentJournalEntry) return;

  for (const file of files) {
    if (!file || !String(file.type || '').startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (!currentJournalEntry.screenshots) currentJournalEntry.screenshots = [];
      currentJournalEntry.screenshots.push(e.target.result);
      renderJournalScreenshots();
    };
    reader.readAsDataURL(file);
  }
}

function handleJournalPaste(event) {
  if (!currentJournalEntry || !event || !event.clipboardData) return;
  const items = Array.from(event.clipboardData.items || []);
  const imageFiles = items
    .filter(item => item && item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map(item => item.getAsFile())
    .filter(Boolean);

  if (!imageFiles.length) return;
  event.preventDefault();
  addJournalScreenshotsFromFiles(imageFiles);
}

function removeJournalScreenshot(idx) {
  if (currentJournalEntry && currentJournalEntry.screenshots) {
    currentJournalEntry.screenshots.splice(idx, 1);
    renderJournalScreenshots();
  }
}

function saveJournalEntry() {
  if (!currentJournalEntry) return;
  currentJournalEntry.notes = document.getElementById('journalNotes').value;

  const strategySelect = document.getElementById('journalStrategy');
  const customInput = document.getElementById('journalStrategyCustom');
  if (strategySelect.value === 'Other') {
    currentJournalEntry.strategy = customInput.value || '';
  } else {
    currentJournalEntry.strategy = strategySelect.value || '';
  }

  currentJournalEntry.updatedAt = new Date().toISOString();
  saveDB(db);
  addLog('Journal entry saved', 'success');
  closeJournalModal();
  renderJournal();
}

function handleStrategyChange() {
  const strategySelect = document.getElementById('journalStrategy');
  const customInput = document.getElementById('journalStrategyCustom');
  if (strategySelect.value === 'Other') {
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
  }
}

async function fetchAndRenderPriceChart() {
  if (!currentJournalEntry) return;

  const symbol = currentJournalEntry.underlying || currentJournalEntry.symbol;
  const tradeDate = currentJournalEntry.date;

  try {
    const prices = await fetchHistoricalPrices(symbol, tradeDate);
    renderPriceChart(prices, tradeDate, currentJournalEntry.price);
  } catch (error) {
    const container = document.getElementById('journalChartContainer');
    container.innerHTML = `<div style="color:var(--red);text-align:center;padding:20px;">Error loading price chart: ${error.message}</div>`;
  }
}

async function fetchHistoricalPrices(symbol, tradeDate) {
  const apiKey = 'lF1AaokGHOg3gJsrviJledCLIUIz2QnI';
  const startDate = new Date(tradeDate);
  startDate.setDate(startDate.getDate() - 20);
  const endDate = new Date(tradeDate);
  endDate.setDate(endDate.getDate() + 30);

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${apiKey}&outputsize=full`;

  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to fetch price data');

  const data = await response.json();
  if (data['Error Message']) throw new Error(data['Error Message']);

  const timeSeries = data['Time Series (Daily)'] || {};
  const prices = [];

  for (const [dateStr, ohlc] of Object.entries(timeSeries)) {
    const currentDate = new Date(dateStr);
    if (currentDate >= startDate && currentDate <= endDate) {
      prices.push({
        date: dateStr,
        open: parseFloat(ohlc['1. open']),
        high: parseFloat(ohlc['2. high']),
        low: parseFloat(ohlc['3. low']),
        close: parseFloat(ohlc['4. close']),
        volume: parseInt(ohlc['5. volume']),
      });
    }
  }

  return prices.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function renderPriceChart(prices, tradeDate, tradePrice) {
  const container = document.getElementById('journalChartContainer');

  if (!prices || prices.length === 0) {
    container.innerHTML = '<div style="color:var(--text2);text-align:center;padding:20px;">No price data available for this period.</div>';
    return;
  }

  const width = container.offsetWidth;
  const height = 300;
  const padding = 40;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  const minPrice = Math.min(...prices.map(p => p.low));
  const maxPrice = Math.max(...prices.map(p => p.high));
  const priceRange = maxPrice - minPrice;

  const xScale = chartWidth / (prices.length - 1 || 1);
  const yScale = chartHeight / (priceRange || 1);

  let svg = `<svg width="${width}" height="${height}" style="background:var(--bg1);border-radius:4px;">`;

  // Axes
  svg += `<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border)" stroke-width="1"/>`;
  svg += `<line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="var(--border)" stroke-width="1"/>`;

  // Price line
  for (let i = 0; i < prices.length - 1; i++) {
    const x1 = padding + i * xScale;
    const y1 = height - padding - (prices[i].close - minPrice) * yScale;
    const x2 = padding + (i + 1) * xScale;
    const y2 = height - padding - (prices[i + 1].close - minPrice) * yScale;
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--accent)" stroke-width="2"/>`;
  }

  // Trade entry marker
  const tradeIdx = prices.findIndex(p => p.date === tradeDate);
  if (tradeIdx >= 0 && tradePrice) {
    const x = padding + tradeIdx * xScale;
    const y = height - padding - (tradePrice - minPrice) * yScale;
    svg += `<circle cx="${x}" cy="${y}" r="5" fill="var(--green)" stroke="#fff" stroke-width="2"/>`;
    svg += `<text x="${x}" y="${y - 15}" text-anchor="middle" font-size="12" fill="var(--text1)">Entry: $${tradePrice.toFixed(2)}</text>`;
  }

  svg += `</svg>`;
  container.innerHTML = svg;
}


// ════════════════════════════════════════════════════════
// JOURNAL REPORT - IRS AUDIT DOCUMENTATION
// ════════════════════════════════════════════════════════
function renderJournalReport() {
  const dateStart = document.getElementById('jrDateStart')?.value || '';
  const dateEnd = document.getElementById('jrDateEnd')?.value || '';

  let filtered = db.journalEntries.filter(e => {
    const date = e.date || e.createdAt;
    if (dateStart && date < dateStart) return false;
    if (dateEnd && date > dateEnd) return false;
    return true;
  });

  if (filtered.length === 0) {
    document.getElementById('journalReportContainer').innerHTML = '<div style="text-align:center;color:var(--text2);padding:40px;">No journal entries in this date range.</div>';
    return;
  }

  // Calculate metrics
  const byStrategy = {};
  const byTicker = {};
  const byAction = {};
  let totalNotes = 0;
  let withStrategy = 0;
  let withScreenshots = 0;

  for (const entry of filtered) {
    const strategy = entry.strategy || 'Unassigned';
    const ticker = entry.underlying || entry.symbol;
    const action = entry.action;

    if (!byStrategy[strategy]) byStrategy[strategy] = { count: 0, entries: [] };
    if (!byTicker[ticker]) byTicker[ticker] = { count: 0, entries: [] };
    if (!byAction[action]) byAction[action] = { count: 0 };

    byStrategy[strategy].count++;
    byStrategy[strategy].entries.push(entry);
    byTicker[ticker].count++;
    byTicker[ticker].entries.push(entry);
    byAction[action].count++;

    if (entry.notes) totalNotes++;
    if (entry.strategy) withStrategy++;
    if (entry.screenshots && entry.screenshots.length > 0) withScreenshots++;
  }

  let html = '';

  // KPIs
  html += `<div class="card" style="margin-bottom:16px;">
    <div class="card-header"><span class="card-title">Documentation Overview</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;padding:20px;">
      <div style="text-align:center;">
        <div style="font-size:24px;color:var(--accent);font-weight:700;">${filtered.length}</div>
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;margin-top:4px;">Total Trades</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:24px;color:var(--green);font-weight:700;">${withStrategy}</div>
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;margin-top:4px;">With Strategy</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:24px;color:var(--accent);font-weight:700;">${totalNotes}</div>
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;margin-top:4px;">With Notes</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:24px;color:var(--accent);font-weight:700;">${withScreenshots}</div>
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;margin-top:4px;">With Evidence</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:24px;color:var(--amber);font-weight:700;">${Object.keys(byStrategy).length}</div>
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;margin-top:4px;">Strategies Used</div>
      </div>
      <div style="text-align:center;">
        <div style="font-size:24px;color:var(--accent);font-weight:700;">${Object.keys(byTicker).length}</div>
        <div style="font-size:11px;color:var(--text2);text-transform:uppercase;margin-top:4px;">Tickers</div>
      </div>
    </div>
  </div>`;

  // By Strategy
  html += `<div class="card" style="margin-bottom:16px;">
    <div class="card-header"><span class="card-title">Trades by Strategy</span></div>
    <div class="tbl-wrap"><table style="width:100%;">
      <thead><tr style="background:var(--bg2);">
        <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;">Strategy</th>
        <th style="padding:12px;text-align:right;">Count</th>
        <th style="padding:12px;text-align:right;">With Notes %</th>
        <th style="padding:12px;text-align:right;">With Evidence %</th>
      </tr></thead>
      <tbody>`;

  Object.keys(byStrategy).sort((a, b) => byStrategy[b].count - byStrategy[a].count).forEach(strategy => {
    const data = byStrategy[strategy];
    const notesCount = data.entries.filter(e => e.notes).length;
    const screenshotCount = data.entries.filter(e => e.screenshots && e.screenshots.length > 0).length;
    html += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:12px;"><strong>${strategy}</strong></td>
      <td style="padding:12px;text-align:right;color:var(--accent);font-weight:700;">${data.count}</td>
      <td style="padding:12px;text-align:right;color:var(--text1);">${((notesCount/data.count)*100).toFixed(0)}%</td>
      <td style="padding:12px;text-align:right;color:var(--text1);">${((screenshotCount/data.count)*100).toFixed(0)}%</td>
    </tr>`;
  });

  html += `</tbody></table></div></div>`;

  // By Ticker
  html += `<div class="card" style="margin-bottom:16px;">
    <div class="card-header"><span class="card-title">Trades by Ticker</span></div>
    <div class="tbl-wrap"><table style="width:100%;">
      <thead><tr style="background:var(--bg2);">
        <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;">Ticker</th>
        <th style="padding:12px;text-align:right;">Count</th>
        <th style="padding:12px;text-align:right;">Documented %</th>
      </tr></thead>
      <tbody>`;

  Object.keys(byTicker).sort((a, b) => byTicker[b].count - byTicker[a].count).forEach(ticker => {
    const data = byTicker[ticker];
    const documented = data.entries.filter(e => e.strategy || e.notes).length;
    html += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:12px;"><strong>${ticker}</strong></td>
      <td style="padding:12px;text-align:right;color:var(--accent);font-weight:700;">${data.count}</td>
      <td style="padding:12px;text-align:right;color:var(--text1);">${((documented/data.count)*100).toFixed(0)}%</td>
    </tr>`;
  });

  html += `</tbody></table></div></div>`;

  // By Action Type
  html += `<div class="card" style="margin-bottom:16px;">
    <div class="card-header"><span class="card-title">Trades by Action Type</span></div>
    <div class="tbl-wrap"><table style="width:100%;">
      <thead><tr style="background:var(--bg2);">
        <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;">Action</th>
        <th style="padding:12px;text-align:right;">Count</th>
        <th style="padding:12px;text-align:right;">% of Total</th>
      </tr></thead>
      <tbody>`;

  Object.keys(byAction).sort((a, b) => byAction[b].count - byAction[a].count).forEach(action => {
    const count = byAction[action].count;
    html += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:12px;"><strong>${action}</strong></td>
      <td style="padding:12px;text-align:right;color:var(--accent);font-weight:700;">${count}</td>
      <td style="padding:12px;text-align:right;color:var(--text1);">${((count/filtered.length)*100).toFixed(1)}%</td>
    </tr>`;
  });

  html += `</tbody></table></div></div>`;

  // Recent Trades with Documentation
  html += `<div class="card">
    <div class="card-header"><span class="card-title">Recent Trade Documentation Timeline</span></div>
    <div class="tbl-wrap"><table style="width:100%;font-size:12px;">
      <thead><tr style="background:var(--bg2);">
        <th style="padding:10px;text-align:left;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;width:80px;">Date</th>
        <th style="padding:10px;text-align:left;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;">Ticker</th>
        <th style="padding:10px;text-align:left;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;">Strategy</th>
        <th style="padding:10px;text-align:left;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;">Action</th>
        <th style="padding:10px;text-align:left;font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;">Notes</th>
      </tr></thead>
      <tbody>`;

  filtered.sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt)).slice(0, 50).forEach(entry => {
    const ticker = entry.underlying || entry.symbol;
    const strategy = entry.strategy || '—';
    const hasNotes = entry.notes ? '✓' : '—';
    const notePreview = entry.notes ? entry.notes.substring(0, 40) + (entry.notes.length > 40 ? '...' : '') : '';
    html += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:10px;color:var(--text1);">${entry.date}</td>
      <td style="padding:10px;color:var(--accent);font-weight:700;">${ticker}</td>
      <td style="padding:10px;color:var(--text1);">${strategy}</td>
      <td style="padding:10px;color:var(--text1);font-size:11px;">${entry.action}</td>
      <td style="padding:10px;color:var(--text2);font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${notePreview || '—'}</td>
    </tr>`;
  });

  html += `</tbody></table></div></div>`;

  document.getElementById('journalReportContainer').innerHTML = html;
}

function jrExportCSV() {
  const dateStart = document.getElementById('jrDateStart')?.value || '';
  const dateEnd = document.getElementById('jrDateEnd')?.value || '';

  let filtered = db.journalEntries.filter(e => {
    const date = e.date || e.createdAt;
    if (dateStart && date < dateStart) return false;
    if (dateEnd && date > dateEnd) return false;
    return true;
  });

  let csv = 'TGCapital Trading Journal Report\n';
  csv += `Generated: ${new Date().toISOString()}\n`;
  if (dateStart || dateEnd) csv += `Period: ${dateStart} to ${dateEnd}\n`;
  csv += '\n';

  // KPIs
  csv += 'DOCUMENTATION OVERVIEW\n';
  csv += `Total Trades Documented,${filtered.length}\n`;
  csv += `With Strategy,${filtered.filter(e => e.strategy).length}\n`;
  csv += `With Trade Notes,${filtered.filter(e => e.notes).length}\n`;
  csv += `With Evidence (Screenshots),${filtered.filter(e => e.screenshots && e.screenshots.length > 0).length}\n`;
  csv += '\n';

  // By Strategy
  csv += 'TRADES BY STRATEGY\n';
  csv += 'Strategy,Count,With Notes %,With Evidence %\n';
  const byStrategy = {};
  for (const entry of filtered) {
    const strategy = entry.strategy || 'Unassigned';
    if (!byStrategy[strategy]) byStrategy[strategy] = { count: 0, entries: [] };
    byStrategy[strategy].count++;
    byStrategy[strategy].entries.push(entry);
  }
  Object.keys(byStrategy).sort((a, b) => byStrategy[b].count - byStrategy[a].count).forEach(strategy => {
    const data = byStrategy[strategy];
    const notesCount = data.entries.filter(e => e.notes).length;
    const screenshotCount = data.entries.filter(e => e.screenshots && e.screenshots.length > 0).length;
    csv += `"${strategy}",${data.count},${((notesCount/data.count)*100).toFixed(0)},${((screenshotCount/data.count)*100).toFixed(0)}\n`;
  });
  csv += '\n';

  // By Ticker
  csv += 'TRADES BY TICKER\n';
  csv += 'Ticker,Count,Documented %\n';
  const byTicker = {};
  for (const entry of filtered) {
    const ticker = entry.underlying || entry.symbol;
    if (!byTicker[ticker]) byTicker[ticker] = { count: 0, entries: [] };
    byTicker[ticker].count++;
    byTicker[ticker].entries.push(entry);
  }
  Object.keys(byTicker).sort((a, b) => byTicker[b].count - byTicker[a].count).forEach(ticker => {
    const data = byTicker[ticker];
    const documented = data.entries.filter(e => e.strategy || e.notes).length;
    csv += `"${ticker}",${data.count},${((documented/data.count)*100).toFixed(0)}\n`;
  });
  csv += '\n';

  // Detailed Timeline
  csv += 'TRADE DOCUMENTATION TIMELINE\n';
  csv += 'Date,Ticker,Strategy,Action,Qty,Price,Notes\n';
  filtered.sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt)).forEach(entry => {
    const ticker = entry.underlying || entry.symbol;
    const strategy = entry.strategy || '';
    csv += `"${entry.date}","${ticker}","${strategy}","${entry.action}",${entry.quantity},${entry.price},"${(entry.notes || '').replace(/"/g, '""')}"\n`;
  });

  const filename = `TGCapital_JournalReport_${dateStart || 'all'}_to_${dateEnd || 'all'}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.setAttribute('href', URL.createObjectURL(blob));
  link.setAttribute('download', filename);
  link.click();
}

