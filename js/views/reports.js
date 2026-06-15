// ════════════════════════════════════════════════════════
// REPORTS VIEW
// ════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────
let rptState = {
  dateFrom:   '',
  dateTo:     '',
  ticker:     '',
  instrument: 'all',
  closeType:  'all',
  result:     'all',
};

// Sync filter controls → state, then re-render
function renderReports() {
  rptState.dateFrom   = document.getElementById('rptDateFrom').value   || '';
  rptState.dateTo     = document.getElementById('rptDateTo').value     || '';
  rptState.ticker     = (document.getElementById('rptTicker').value    || '').trim().toUpperCase();
  rptState.instrument = document.getElementById('rptInstrument').value || 'all';
  rptState.closeType  = document.getElementById('rptCloseType').value  || 'all';
  rptState.result     = document.getElementById('rptResult').value     || 'all';
  _renderReportsWithState();
}

// Quick-range preset buttons
function rptQuickRange(range) {
  const now = new Date();
  const y   = now.getFullYear();
  let from = '', to = '';
  if (range === 'ytd') { from = `${y}-01-01`; to = now.toISOString().slice(0, 10); }
  else if (range === 'q1') { from = `${y}-01-01`; to = `${y}-03-31`; }
  else if (range === 'q2') { from = `${y}-04-01`; to = `${y}-06-30`; }
  else if (range === 'q3') { from = `${y}-07-01`; to = `${y}-09-30`; }
  else if (range === 'q4') { from = `${y}-10-01`; to = `${y}-12-31`; }
  else if (range === 'all') { from = ''; to = ''; }
  document.getElementById('rptDateFrom').value = from;
  document.getElementById('rptDateTo').value   = to;
  renderReports();
}

// ── Core compute ───────────────────────────────────────
function _rptGetFilteredTrades() {
  const { closedTrades } = buildPositions();
  const { dateFrom, dateTo, ticker, instrument, closeType, result } = rptState;

  return closedTrades.filter(t => {
    const cd = t.closeDate || '';
    if (dateFrom && cd < dateFrom) return false;
    if (dateTo   && cd > dateTo)   return false;

    if (ticker) {
      const sym = (t.symbol || '').toUpperCase();
      const und = (t.underlying || '').toUpperCase();
      if (!sym.includes(ticker) && !und.includes(ticker)) return false;
    }

    if (instrument === 'option' && t.instrument !== 'option') return false;
    if (instrument === 'stock'  && t.instrument === 'option') return false;

    if (closeType !== 'all' && t.via !== closeType) return false;

    if (result === 'wins'   && (t.netPnl || 0) <= 0) return false;
    if (result === 'losses' && (t.netPnl || 0) >= 0) return false;

    return true;
  });
}

function _rptGetFilteredIncome() {
  const INCOME_ACTIONS = new Set(['Cash Dividend','Pr Yr Cash Div','Pr Yr Non-Qual Div','Credit Interest','ADR Mgmt Fee']);
  const { dateFrom, dateTo, ticker } = rptState;

  return db.transactions.filter(t => {
    if (!INCOME_ACTIONS.has(t.action)) return false;
    const d = t.date || '';
    if (dateFrom && d < dateFrom) return false;
    if (dateTo   && d > dateTo)   return false;
    if (ticker) {
      const sym = (t.symbol || '').toUpperCase();
      if (!sym.includes(ticker)) return false;
    }
    return true;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function _rptGetFilteredWash() {
  const { dateFrom, dateTo, ticker } = rptState;
  let txns = db.transactions;
  if (dateFrom || dateTo) {
    txns = txns.filter(t => {
      const d = t.date || '';
      if (dateFrom && d < dateFrom) return false;
      if (dateTo   && d > dateTo)   return false;
      return true;
    });
  }
  let flags = detectWashSales(txns);
  if (ticker) flags = flags.filter(f => (f.symbol || '').toUpperCase().includes(ticker));
  return flags;
}

// ── Main renderer ──────────────────────────────────────
function _renderReportsWithState() {
  const trades  = _rptGetFilteredTrades();
  const income  = _rptGetFilteredIncome();
  const wash    = _rptGetFilteredWash();

  // ── Update print header meta
  const { dateFrom, dateTo } = rptState;
  const rangeLabel = (dateFrom || dateTo)
    ? `Period: ${dateFrom || 'start'} to ${dateTo || 'present'}`
    : 'Period: All Available Data';
  document.getElementById('rptPrintMeta').innerHTML =
    `${rangeLabel} &nbsp;|&nbsp; Generated: ${new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})}` +
    (rptState.ticker ? ` &nbsp;|&nbsp; Ticker filter: ${rptState.ticker}` : '');

  // ── Aggregates
  const totalPnl      = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const totalGross    = trades.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const totalFees     = trades.reduce((s, t) => s + (t.fees || 0), 0);
  const totalPremium  = trades.filter(t => t.instrument === 'option').reduce((s, t) => s + Math.max(0, t.openCredit || 0), 0);
  const totalIncome   = income.reduce((s, t) => s + (t.amount || 0), 0);
  const wins          = trades.filter(t => (t.netPnl || 0) > 0);
  const losses        = trades.filter(t => (t.netPnl || 0) < 0);
  const winRate       = trades.length > 0 ? wins.length / trades.length : null;
  const avgWin        = wins.length   > 0 ? wins.reduce((s, t) => s + t.netPnl, 0)   / wins.length   : null;
  const avgLoss       = losses.length > 0 ? losses.reduce((s, t) => s + t.netPnl, 0) / losses.length : null;

  // ── KPI Strip
  const kpiData = [
    { label: 'Realized P&L',       val: totalPnl,     sub: `${trades.length} closed trades`,  color: totalPnl >= 0 ? 'var(--green)' : 'var(--red)' },
    { label: 'Premium Collected',  val: totalPremium, sub: 'Options only',                    color: 'var(--text0)' },
    { label: 'Total Fees Paid',    val: -totalFees,   sub: 'Embedded in amounts',             color: 'var(--red)' },
    { label: 'Income (Divs/Int)',  val: totalIncome,  sub: `${income.length} events`,         color: 'var(--teal)' },
    { label: 'Win Rate',           val: null,         sub: `${wins.length}W / ${losses.length}L`, color: winRate !== null && winRate >= 0.5 ? 'var(--green)' : 'var(--red)',
      rawText: winRate !== null ? (winRate * 100).toFixed(1) + '%' : '—' },
    { label: 'Avg Win / Avg Loss', val: null,         sub: `per trade`,                       color: 'var(--text0)',
      rawText: (avgWin !== null ? fmt$(avgWin) : '—') + ' / ' + (avgLoss !== null ? fmt$(avgLoss) : '—') },
    { label: 'Gross P&L',          val: totalGross,   sub: 'Before fee adjustment',           color: totalGross >= 0 ? 'var(--green)' : 'var(--red)' },
    { label: 'Wash Sale Flags',    val: null,         sub: 'Review required',                 color: wash.length > 0 ? 'var(--amber)' : 'var(--text2)',
      rawText: String(wash.length) },
  ];
  document.getElementById('rptKpiRow').innerHTML = kpiData.map(k => `
    <div class="rpt-kpi">
      <div class="rpt-kpi-label">${k.label}</div>
      <div class="rpt-kpi-val" style="color:${k.color}">${k.rawText !== undefined ? k.rawText : fmt$(k.val)}</div>
      <div class="rpt-kpi-sub">${k.sub}</div>
    </div>`).join('');

  // ── Detail table
  const sortedTrades = [...trades].sort((a, b) => (b.closeDate || '').localeCompare(a.closeDate || ''));
  document.getElementById('rptDetailCount').textContent = `${sortedTrades.length} trade${sortedTrades.length !== 1 ? 's' : ''}`;

  const detailRows = sortedTrades.map(t => {
    const pnlCls  = (t.netPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)';
    const grossCls= (t.grossPnl || 0) >= 0 ? 'var(--green)' : 'var(--red)';
    const outcomeLabel = t.via === 'expired' ? 'Expired' : t.via === 'assigned' ? 'Assigned' : t.via === 'sold' ? 'Sold' : 'BTC';
    const instLabel    = t.instrument === 'option' ? (t.optionType === 'put' ? 'PUT' : 'CALL') : (t.instrument || '').toUpperCase();
    const openPriceStr = t.instrument === 'option'
      ? (t.openPrice ? '$' + t.openPrice.toFixed(2) : '—')
      : (t.openPrice ? '$' + t.openPrice.toFixed(2) : '—');
    const closePriceStr = t.via === 'expired' ? '$0.00'
      : t.via === 'assigned' ? (t.strike ? '$' + t.strike.toFixed(2) : '—')
      : (t.closePrice ? '$' + t.closePrice.toFixed(2) : '—');
    const closeAmtStr = t.via === 'expired' ? '$0.00'
      : t.via === 'assigned' ? '(stock recv.)'
      : fmt$(t.closeCost);
    return `<tr>
      <td style="font-family:var(--mono)">${t.closeDate || '—'}</td>
      <td style="font-family:var(--mono);color:var(--text2)">${t.openDate || '—'}</td>
      <td style="font-family:var(--mono);font-weight:700">${t.underlying || t.symbol || '—'}</td>
      <td>${instLabel}</td>
      <td style="color:var(--text2);font-size:11px">${t.optionType ? t.optionType.toUpperCase() : (t.instrument || '')}</td>
      <td class="r">${t.strike != null ? '$' + t.strike.toFixed(2) : '—'}</td>
      <td style="font-family:var(--mono);font-size:11px">${t.expiry || '—'}</td>
      <td class="r">${t.qty || 1}</td>
      <td class="r">${openPriceStr}</td>
      <td class="r" style="color:var(--green)">${fmt$(Math.abs(t.openCredit || 0))}</td>
      <td class="r">${closePriceStr}</td>
      <td class="r">${closeAmtStr}</td>
      <td style="font-size:11px">${outcomeLabel}</td>
      <td class="r" style="color:var(--red)">${t.fees > 0 ? '-' + fmt$(t.fees) : '—'}</td>
      <td class="r" style="font-weight:700;color:${pnlCls}">${fmt$(t.netPnl)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="15" style="text-align:center;color:var(--text2);padding:20px">No trades match the selected filters.</td></tr>';

  document.querySelector('#rptDetailTable tbody').innerHTML = detailRows;

  // Detail footer
  document.getElementById('rptFootPremium').innerHTML = `<strong>${fmt$(totalPremium)}</strong>`;
  document.getElementById('rptFootClose').innerHTML   = `<strong>${fmt$(trades.reduce((s, t) => s + Math.abs(t.closeCost || 0), 0))}</strong>`;
  document.getElementById('rptFootFees').innerHTML    = `<strong style="color:var(--red)">-${fmt$(totalFees)}</strong>`;
  document.getElementById('rptFootNet').innerHTML     = `<strong style="color:${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt$(totalPnl)}</strong>`;

  // ── Summary by underlying
  const byUnderlying = {};
  for (const t of trades) {
    const k = t.underlying || (t.symbol || '').split(' ')[0];
    if (!byUnderlying[k]) byUnderlying[k] = { trades: 0, wins: 0, losses: 0, premium: 0, fees: 0, gross: 0, net: 0 };
    const g = byUnderlying[k];
    g.trades++;
    if ((t.netPnl || 0) > 0) g.wins++;
    if ((t.netPnl || 0) < 0) g.losses++;
    g.premium += t.instrument === 'option' ? Math.max(0, t.openCredit || 0) : 0;
    g.fees    += t.fees || 0;
    g.gross   += t.grossPnl || 0;
    g.net     += t.netPnl || 0;
  }

  const summaryRows = Object.entries(byUnderlying)
    .sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net));

  document.getElementById('rptSummaryCount').textContent = `${summaryRows.length} underlying${summaryRows.length !== 1 ? 's' : ''}`;

  const sumBody = summaryRows.map(([sym, g]) => {
    const wr    = g.trades > 0 ? (g.wins / g.trades * 100).toFixed(1) + '%' : '—';
    const pct   = totalPnl !== 0 ? (g.net / totalPnl * 100).toFixed(1) + '%' : '—';
    const netCls= g.net >= 0 ? 'var(--green)' : 'var(--red)';
    const grCls = g.gross >= 0 ? 'var(--green)' : 'var(--red)';
    return `<tr>
      <td style="font-family:var(--mono);font-weight:700">${sym}</td>
      <td class="r">${g.trades}</td>
      <td class="r" style="color:var(--green)">${g.wins}</td>
      <td class="r" style="color:var(--red)">${g.losses}</td>
      <td class="r" style="color:${g.wins / g.trades >= 0.5 ? 'var(--green)' : 'var(--red)'}">${wr}</td>
      <td class="r">${fmt$(g.premium)}</td>
      <td class="r" style="color:var(--red)">${g.fees > 0 ? '-' + fmt$(g.fees) : '—'}</td>
      <td class="r" style="color:${grCls}">${fmt$(g.gross)}</td>
      <td class="r" style="font-weight:700;color:${netCls}">${fmt$(g.net)}</td>
      <td class="r" style="color:var(--text2)">${pct}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--text2);padding:20px">No data.</td></tr>';

  document.querySelector('#rptSummaryTable tbody').innerHTML = sumBody;

  // Summary footer
  const totalTrades = summaryRows.reduce((s, [,g]) => s + g.trades, 0);
  const totalWins   = summaryRows.reduce((s, [,g]) => s + g.wins,   0);
  const totalLosses = summaryRows.reduce((s, [,g]) => s + g.losses, 0);
  const totalSumPrem= summaryRows.reduce((s, [,g]) => s + g.premium,0);
  const totalSumFees= summaryRows.reduce((s, [,g]) => s + g.fees,   0);
  const totalSumGrs = summaryRows.reduce((s, [,g]) => s + g.gross,  0);
  const totalSumNet = summaryRows.reduce((s, [,g]) => s + g.net,    0);
  const totalWR     = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) + '%' : '—';

  document.getElementById('rptSumFootTrades').innerHTML  = `<strong>${totalTrades}</strong>`;
  document.getElementById('rptSumFootWins').innerHTML    = `<strong style="color:var(--green)">${totalWins}</strong>`;
  document.getElementById('rptSumFootLosses').innerHTML  = `<strong style="color:var(--red)">${totalLosses}</strong>`;
  document.getElementById('rptSumFootWR').innerHTML      = `<strong>${totalWR}</strong>`;
  document.getElementById('rptSumFootPrem').innerHTML    = `<strong>${fmt$(totalSumPrem)}</strong>`;
  document.getElementById('rptSumFootFees').innerHTML    = `<strong style="color:var(--red)">-${fmt$(totalSumFees)}</strong>`;
  document.getElementById('rptSumFootGross').innerHTML   = `<strong style="color:${totalSumGrs >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt$(totalSumGrs)}</strong>`;
  document.getElementById('rptSumFootNet').innerHTML     = `<strong style="color:${totalSumNet >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt$(totalSumNet)}</strong>`;

  // ── Income table
  const INCOME_TYPE_LABELS = {
    'Cash Dividend':      'Dividend',
    'Pr Yr Cash Div':     'Prior Yr Div',
    'Pr Yr Non-Qual Div': 'Prior Yr Non-Qual',
    'Credit Interest':    'Interest',
    'ADR Mgmt Fee':       'ADR Fee',
  };
  document.getElementById('rptIncomeCount').textContent = `${income.length} event${income.length !== 1 ? 's' : ''}`;

  document.querySelector('#rptIncomeTable tbody').innerHTML = income.map(t => {
    const amtCls = (t.amount || 0) >= 0 ? 'var(--green)' : 'var(--red)';
    return `<tr>
      <td style="font-family:var(--mono)">${t.date || '—'}</td>
      <td style="font-family:var(--mono);font-weight:700">${t.symbol || '—'}</td>
      <td>${INCOME_TYPE_LABELS[t.action] || t.action}</td>
      <td style="color:var(--text2);font-size:11px">${(t.description || '').substring(0, 60)}</td>
      <td class="r" style="color:${amtCls};font-weight:700">${fmt$(t.amount)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:20px">No income events in this period.</td></tr>';

  document.getElementById('rptIncomeTotal').innerHTML =
    `<strong style="color:${totalIncome >= 0 ? 'var(--teal)' : 'var(--red)'}">${fmt$(totalIncome)}</strong>`;

  // ── Wash sales table
  document.getElementById('rptWashCount').textContent =
    wash.length > 0 ? `${wash.length} potential violation${wash.length !== 1 ? 's' : ''}` : 'None detected';

  document.querySelector('#rptWashTable tbody').innerHTML = wash.map(f => {
    const riskColor = f.risk === 'HIGH' ? 'var(--red)' : f.risk === 'MEDIUM' ? 'var(--amber)' : 'var(--text2)';
    const note = f.risk === 'HIGH'
      ? 'Loss & repurchase within 7 days — likely disallowed'
      : f.risk === 'MEDIUM'
      ? 'Loss & repurchase 8–14 days apart — review required'
      : 'Loss & repurchase 15–30 days apart — monitor';
    return `<tr>
      <td style="font-family:var(--mono);font-weight:700">${f.symbol}</td>
      <td style="font-family:var(--mono)">${f.lossDate}</td>
      <td class="r" style="color:var(--red)">${fmt$(f.lossAmount)}</td>
      <td style="font-family:var(--mono)">${f.repDate}</td>
      <td class="r">${f.daysApart}d</td>
      <td style="color:var(--text1)">${f.repAction}</td>
      <td class="c" style="color:${riskColor};font-family:var(--mono);font-weight:700">${f.risk}</td>
      <td style="font-size:11px;color:var(--text2)">${note}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:20px">No wash sale flags in this period.</td></tr>';

  // Store for CSV export
  window._rptData = { trades: sortedTrades, summaryRows, income, wash, totalPnl, totalFees, totalIncome };
}

// ── CSV Export ─────────────────────────────────────────
function _rptDownloadCSV(filename, rows) {
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function _csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function rptExportDetailCSV() {
  const d = window._rptData;
  if (!d || !d.trades.length) { alert('No data to export. Apply filters first.'); return; }

  const { dateFrom, dateTo } = rptState;
  const rows = [
    ['TGCapital Trading Report — Detail'],
    [`Period: ${dateFrom || 'start'} to ${dateTo || 'present'}`, `Generated: ${new Date().toLocaleDateString()}`],
    [],
    ['Close Date','Open Date','Underlying','Symbol','Instrument','Option Type','Strike','Expiry','Qty',
     'Open Price','Premium / Cost Basis','Close Price','Close Amount','Outcome','Fees','Net P&L','Gross P&L'].map(_csvCell).join(','),
    ...d.trades.map(t => [
      t.closeDate || '',
      t.openDate  || '',
      t.underlying || (t.symbol || '').split(' ')[0],
      t.symbol    || '',
      t.instrument|| '',
      t.optionType|| '',
      t.strike    != null ? t.strike.toFixed(2) : '',
      t.expiry    || '',
      t.qty       || 1,
      t.openPrice != null ? t.openPrice.toFixed(4) : '',
      (t.openCredit || 0).toFixed(2),
      t.closePrice != null ? t.closePrice.toFixed(4) : '',
      (t.closeCost  || 0).toFixed(2),
      t.via       || '',
      (t.fees     || 0).toFixed(2),
      (t.netPnl   || 0).toFixed(2),
      (t.grossPnl || 0).toFixed(2),
    ].map(_csvCell).join(',')),
    [],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', 'TOTAL FEES', d.trades.reduce((s,t) => s+(t.fees||0),0).toFixed(2),
     d.trades.reduce((s,t) => s+(t.netPnl||0),0).toFixed(2),
     d.trades.reduce((s,t) => s+(t.grossPnl||0),0).toFixed(2)].map(_csvCell).join(','),
  ];
  const dateTag = (dateFrom || dateTo) ? `_${(dateFrom||'').replace(/-/g,'')}-${(dateTo||'').replace(/-/g,'')}` : '';
  _rptDownloadCSV(`TGCapital_TradeDetail${dateTag}.csv`, rows);
}

function rptExportSummaryCSV() {
  const d = window._rptData;
  if (!d || !d.summaryRows.length) { alert('No data to export. Apply filters first.'); return; }

  const { dateFrom, dateTo } = rptState;
  const totalNet = d.summaryRows.reduce((s, [,g]) => s + g.net, 0);
  const rows = [
    ['TGCapital Trading Report — Summary by Underlying'],
    [`Period: ${dateFrom || 'start'} to ${dateTo || 'present'}`, `Generated: ${new Date().toLocaleDateString()}`],
    [],
    ['Underlying','Trades','Wins','Losses','Win Rate','Premium Collected','Total Fees','Gross P&L','Net P&L','% of Total'].map(_csvCell).join(','),
    ...d.summaryRows.map(([sym, g]) => {
      const wr  = g.trades > 0 ? (g.wins / g.trades * 100).toFixed(1) + '%' : '0%';
      const pct = totalNet !== 0 ? (g.net / totalNet * 100).toFixed(1) + '%' : '—';
      return [sym, g.trades, g.wins, g.losses, wr,
              g.premium.toFixed(2), g.fees.toFixed(2), g.gross.toFixed(2), g.net.toFixed(2), pct].map(_csvCell).join(',');
    }),
    [],
    // Income section
    [''],
    ['Income & Cash Events'],
    ['Date','Symbol','Type','Description','Amount'].map(_csvCell).join(','),
    ...d.income.map(t => [t.date||'', t.symbol||'', t.action||'', t.description||'', (t.amount||0).toFixed(2)].map(_csvCell).join(',')),
    ['','','','Total Income', d.income.reduce((s,t) => s+(t.amount||0),0).toFixed(2)].map(_csvCell).join(','),
  ];
  const dateTag = (dateFrom || dateTo) ? `_${(dateFrom||'').replace(/-/g,'')}-${(dateTo||'').replace(/-/g,'')}` : '';
  _rptDownloadCSV(`TGCapital_Summary${dateTag}.csv`, rows);
}

// ── XLSX Export ────────────────────────────────────────
function _rptDateTag() {
  const { dateFrom, dateTo } = rptState;
  return (dateFrom || dateTo) ? `_${(dateFrom||'').replace(/-/g,'')}-${(dateTo||'').replace(/-/g,'')}` : '';
}

function rptExportDetailXLSX() {
  const d = window._rptData;
  if (!d || !d.trades.length) { alert('No data to export. Apply filters first.'); return; }

  const { dateFrom, dateTo } = rptState;
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Trade Detail
  const detailHeader = ['Close Date','Open Date','Underlying','Symbol','Instrument','Option Type',
    'Strike','Expiry','Qty','Open Price','Premium / Cost Basis','Close Price','Close Amount',
    'Outcome','Fees','Net P&L','Gross P&L'];
  const detailData = d.trades.map(t => [
    t.closeDate  || '',
    t.openDate   || '',
    t.underlying || (t.symbol || '').split(' ')[0],
    t.symbol     || '',
    t.instrument || '',
    t.optionType || '',
    t.strike     != null ? t.strike    : null,
    t.expiry     || '',
    t.qty        || 1,
    t.openPrice  != null ? t.openPrice : null,
    t.openCredit || 0,
    t.closePrice != null ? t.closePrice : null,
    t.closeCost  || 0,
    t.via        || '',
    t.fees       || 0,
    t.netPnl     || 0,
    t.grossPnl   || 0,
  ]);
  const detailTotals = ['','','','','','','','','','','','','','TOTALS',
    d.trades.reduce((s,t) => s+(t.fees||0),0),
    d.trades.reduce((s,t) => s+(t.netPnl||0),0),
    d.trades.reduce((s,t) => s+(t.grossPnl||0),0),
  ];

  const ws1 = XLSX.utils.aoa_to_sheet([
    [`TGCapital Trading Report — Detail`],
    [`Period: ${dateFrom || 'start'} to ${dateTo || 'present'}   Generated: ${new Date().toLocaleDateString()}`],
    [],
    detailHeader,
    ...detailData,
    [],
    detailTotals,
  ]);
  ws1['!cols'] = [
    {wch:12},{wch:12},{wch:12},{wch:22},{wch:11},{wch:12},{wch:8},{wch:12},{wch:5},
    {wch:11},{wch:19},{wch:12},{wch:14},{wch:10},{wch:8},{wch:10},{wch:10},
  ];
  XLSX.utils.book_append_sheet(wb, ws1, 'Trade Detail');

  // ── Sheet 2: Income & Dividends
  const incomeHeader = ['Date','Symbol','Type','Description','Amount'];
  const incomeData   = d.income.map(t => [t.date||'', t.symbol||'', t.action||'', t.description||'', t.amount||0]);
  const incomeTotal  = ['','','','Total Income', d.income.reduce((s,t) => s+(t.amount||0), 0)];
  const ws2 = XLSX.utils.aoa_to_sheet([incomeHeader, ...incomeData, [], incomeTotal]);
  ws2['!cols'] = [{wch:12},{wch:10},{wch:20},{wch:50},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Income & Dividends');

  XLSX.writeFile(wb, `TGCapital_TradeDetail${_rptDateTag()}.xlsx`);
}

function rptExportSummaryXLSX() {
  const d = window._rptData;
  if (!d || !d.summaryRows.length) { alert('No data to export. Apply filters first.'); return; }

  const { dateFrom, dateTo } = rptState;
  const totalNet = d.summaryRows.reduce((s, [,g]) => s + g.net, 0);
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Summary by Underlying
  const sumHeader = ['Underlying','Trades','Wins','Losses','Win Rate %','Premium Collected','Total Fees','Gross P&L','Net P&L','% of Total'];
  const sumData = d.summaryRows.map(([sym, g]) => [
    sym,
    g.trades,
    g.wins,
    g.losses,
    g.trades > 0 ? +(g.wins / g.trades * 100).toFixed(2) : 0,
    g.premium,
    g.fees,
    g.gross,
    g.net,
    totalNet !== 0 ? +(g.net / totalNet * 100).toFixed(2) : 0,
  ]);
  const sumTotals = ['TOTALS',
    d.summaryRows.reduce((s,[,g]) => s+g.trades,  0),
    d.summaryRows.reduce((s,[,g]) => s+g.wins,    0),
    d.summaryRows.reduce((s,[,g]) => s+g.losses,  0),
    '',
    d.summaryRows.reduce((s,[,g]) => s+g.premium, 0),
    d.summaryRows.reduce((s,[,g]) => s+g.fees,    0),
    d.summaryRows.reduce((s,[,g]) => s+g.gross,   0),
    totalNet,
    '',
  ];

  const ws1 = XLSX.utils.aoa_to_sheet([
    [`TGCapital Trading Report — Summary`],
    [`Period: ${dateFrom || 'start'} to ${dateTo || 'present'}   Generated: ${new Date().toLocaleDateString()}`],
    [],
    sumHeader,
    ...sumData,
    [],
    sumTotals,
  ]);
  ws1['!cols'] = [{wch:12},{wch:8},{wch:6},{wch:8},{wch:11},{wch:20},{wch:12},{wch:12},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary by Underlying');

  // ── Sheet 2: Income & Dividends
  const incomeHeader = ['Date','Symbol','Type','Description','Amount'];
  const incomeData   = d.income.map(t => [t.date||'', t.symbol||'', t.action||'', t.description||'', t.amount||0]);
  const incomeTotal  = ['','','','Total Income', d.income.reduce((s,t) => s+(t.amount||0), 0)];
  const ws2 = XLSX.utils.aoa_to_sheet([incomeHeader, ...incomeData, [], incomeTotal]);
  ws2['!cols'] = [{wch:12},{wch:10},{wch:20},{wch:50},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Income & Dividends');

  XLSX.writeFile(wb, `TGCapital_Summary${_rptDateTag()}.xlsx`);
}
