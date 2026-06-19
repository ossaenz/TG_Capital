// ════════════════════════════════════════════════════════
// WASH SALES VIEW  (Quick Scan + Advanced / CPA sub-tabs)
// ════════════════════════════════════════════════════════

function wsShowPanel(tab) {
  const basic = document.getElementById('ws-panel-basic');
  const adv   = document.getElementById('ws-panel-adv');
  const btnB  = document.getElementById('wsSubtabBasic');
  const btnA  = document.getElementById('wsSubtabAdv');
  if (!basic || !adv) return;
  const showAdv = tab === 'adv';
  basic.style.display = showAdv ? 'none' : '';
  adv.style.display   = showAdv ? ''     : 'none';
  btnB.classList.toggle('active', !showAdv);
  btnA.classList.toggle('active',  showAdv);
  if (showAdv) advRenderAll();
}

// ── State ──────────────────────────────────────────────
let wsState = {
  dateFrom:   '',
  dateTo:     '',
  symbol:     '',
  risk:       'all',
  instrument: 'all',
  sortCol:    'lossDate',
  sortDir:    'desc',
};

// Sync filter controls → state, then re-render
function renderWashSales() {
  wsPopulateYearSelect();
  wsState.dateFrom   = document.getElementById('wsDateFrom').value   || '';
  wsState.dateTo     = document.getElementById('wsDateTo').value     || '';
  wsState.symbol     = (document.getElementById('wsSymbol').value    || '').trim().toUpperCase();
  wsState.risk       = document.getElementById('wsRisk').value       || 'all';
  wsState.instrument = document.getElementById('wsInstrument').value || 'all';
  _renderWashSalesWithState();
}

function wsPopulateYearSelect() {
  const el = document.getElementById('wsYear');
  if (!el) return;
  const years = new Set();
  (db.transactions || []).forEach(t => {
    const y = (t.date || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) years.add(y);
  });
  const sorted = [...years].sort().reverse();
  const current = el.value;
  el.innerHTML = '<option value="">— All —</option>' +
    sorted.map(y => `<option value="${y}">${y}</option>`).join('');
  if (current && sorted.includes(current)) el.value = current;
}

function wsPickYear() {
  const y = document.getElementById('wsYear').value;
  if (y) {
    document.getElementById('wsDateFrom').value = `${y}-01-01`;
    document.getElementById('wsDateTo').value   = `${y}-12-31`;
  } else {
    document.getElementById('wsDateFrom').value = '';
    document.getElementById('wsDateTo').value   = '';
  }
  renderWashSales();
}

function wsClearYear() {
  const el = document.getElementById('wsYear');
  if (el) el.value = '';
}

function wsQuickRange(range) {
  const now    = new Date();
  const yearEl = document.getElementById('wsYear');
  const y = (range !== 'ytd' && range !== 'all' && yearEl && yearEl.value)
    ? parseInt(yearEl.value, 10)
    : now.getFullYear();
  let from = '', to = '';
  if      (range === 'ytd') { from = `${y}-01-01`; to = now.toISOString().slice(0, 10); }
  else if (range === 'q1')  { from = `${y}-01-01`; to = `${y}-03-31`; }
  else if (range === 'q2')  { from = `${y}-04-01`; to = `${y}-06-30`; }
  else if (range === 'q3')  { from = `${y}-07-01`; to = `${y}-09-30`; }
  else if (range === 'q4')  { from = `${y}-10-01`; to = `${y}-12-31`; }
  else if (range === 'all') { from = ''; to = ''; if (yearEl) yearEl.value = ''; }
  document.getElementById('wsDateFrom').value = from;
  document.getElementById('wsDateTo').value   = to;
  renderWashSales();
}

function wsSortBy(col) {
  if (wsState.sortCol === col) {
    wsState.sortDir = wsState.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    wsState.sortCol = col;
    wsState.sortDir = 'asc';
  }
  _renderWashSalesWithState();
}

// ── Filtering & sorting ────────────────────────────────
function _wsGetFilteredFlags() {
  const { dateFrom, dateTo, symbol, risk, instrument } = wsState;
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
  if (symbol)           flags = flags.filter(f => (f.symbol || '').toUpperCase().includes(symbol));
  if (risk !== 'all')   flags = flags.filter(f => f.risk === risk);
  if (instrument !== 'all') {
    flags = flags.filter(f => {
      const isOption = f.lossTxn && f.lossTxn.instrument === 'option';
      return instrument === 'option' ? isOption : !isOption;
    });
  }
  return flags;
}

function _wsSortFlags(flags) {
  const { sortCol, sortDir } = wsState;
  const dir = sortDir === 'asc' ? 1 : -1;
  const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return [...flags].sort((a, b) => {
    let av, bv;
    if      (sortCol === 'symbol')     { av = a.symbol;              bv = b.symbol; }
    else if (sortCol === 'lossDate')   { av = a.lossDate;            bv = b.lossDate; }
    else if (sortCol === 'lossAmount') { av = a.lossAmount;          bv = b.lossAmount; }
    else if (sortCol === 'repDate')    { av = a.repDate;             bv = b.repDate; }
    else if (sortCol === 'daysApart')  { av = a.daysApart;           bv = b.daysApart; }
    else if (sortCol === 'risk')       { av = riskOrder[a.risk] ?? 9; bv = riskOrder[b.risk] ?? 9; }
    else return 0;
    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });
}

// ── Main renderer ──────────────────────────────────────
function _renderWashSalesWithState() {
  const flags  = _wsGetFilteredFlags();
  const sorted = _wsSortFlags(flags);

  // ── Header count
  const countEl = document.getElementById('washCount');
  if (countEl) countEl.textContent = flags.length
    ? `${flags.length} potential violation${flags.length !== 1 ? 's' : ''}`
    : 'No flags';

  // ── KPIs
  const totalLoss = flags.reduce((s, f) => s + (f.lossAmount || 0), 0);
  const highCount = flags.filter(f => f.risk === 'HIGH').length;
  const medCount  = flags.filter(f => f.risk === 'MEDIUM').length;
  const lowCount  = flags.filter(f => f.risk === 'LOW').length;

  const kpiLossColor = totalLoss < 0 ? 'var(--red)' : 'var(--text0)';
  _wsSet('wsKpiFlags',   flags.length);
  _wsSet('wsKpiLoss',    fmt$(totalLoss), kpiLossColor);
  _wsSet('wsKpiHigh',    highCount,       highCount  > 0 ? 'var(--red)'   : 'var(--text0)');
  _wsSet('wsKpiMedLow',  `${medCount} / ${lowCount}`, medCount > 0 ? 'var(--amber)' : 'var(--text0)');

  // ── By-symbol summary
  const symMap = {};
  for (const f of flags) {
    if (!symMap[f.symbol]) symMap[f.symbol] = { count: 0, totalLoss: 0, highestRisk: 'LOW' };
    symMap[f.symbol].count++;
    symMap[f.symbol].totalLoss += f.lossAmount || 0;
    const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    if ((riskOrder[f.risk] ?? 9) < (riskOrder[symMap[f.symbol].highestRisk] ?? 9)) {
      symMap[f.symbol].highestRisk = f.risk;
    }
  }
  const symRows = Object.entries(symMap).sort((a, b) => a[1].totalLoss - b[1].totalLoss);
  const summaryTbody = document.querySelector('#wsSummaryTable tbody');
  if (summaryTbody) {
    if (symRows.length === 0) {
      summaryTbody.innerHTML = '<tr class="empty-row"><td colspan="4">No flags in selected range.</td></tr>';
    } else {
      summaryTbody.innerHTML = symRows.map(([sym, g]) => {
        const rc = g.highestRisk === 'HIGH' ? 'var(--red)' : g.highestRisk === 'MEDIUM' ? 'var(--amber)' : 'var(--text2)';
        return `<tr>
          <td><span style="font-family:var(--mono);font-weight:700">${sym}</span></td>
          <td class="r">${g.count}</td>
          <td class="r"><span class="pos r">${fmt$(g.totalLoss)}</span></td>
          <td><span style="color:${rc};font-family:var(--mono);font-weight:700">${g.highestRisk}</span></td>
        </tr>`;
      }).join('');
    }
  }

  // ── Sort indicators on column headers
  ['symbol','lossDate','lossAmount','repDate','daysApart','risk'].forEach(col => {
    const el = document.getElementById(`wsSort-${col}`);
    if (!el) return;
    el.textContent = wsState.sortCol === col ? (wsState.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  });

  // ── Detail table
  const tbody = document.querySelector('#washTable tbody');
  if (!tbody) return;
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No wash sale flags detected in selected range.</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map(f => {
    const rc = f.risk === 'HIGH' ? 'var(--red)' : f.risk === 'MEDIUM' ? 'var(--amber)' : 'var(--text2)';
    return `<tr>
      <td><span style="font-family:var(--mono);font-weight:700">${f.symbol}</span></td>
      <td>${f.lossDate}</td>
      <td><span class="pos r">${fmt$(f.lossAmount)}</span></td>
      <td>${f.repDate}</td>
      <td class="r">${f.daysApart}d</td>
      <td style="color:var(--text1)">${f.repAction}</td>
      <td><span style="color:${rc};font-family:var(--mono);font-weight:700">${f.risk}</span></td>
    </tr>`;
  }).join('');
}

function _wsSet(id, val, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  if (color) el.style.color = color;
}

// ── CSV Export ─────────────────────────────────────────
function _wsCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function wsExportCSV() {
  const flags = _wsGetFilteredFlags();
  if (!flags.length) { alert('No wash sale flags to export.'); return; }
  const { dateFrom, dateTo } = wsState;
  const rows = [
    ['TGCapital — Wash Sale Flags'],
    [`Period: ${dateFrom || 'start'} to ${dateTo || 'present'}`, `Generated: ${new Date().toLocaleDateString()}`],
    [],
    ['Symbol','Loss Trade Date','Loss Amount','Repurchase Date','Days Apart','Repurchase Action','Risk Level'].map(_wsCell).join(','),
    ...flags.map(f => [
      f.symbol,
      f.lossDate,
      (f.lossAmount || 0).toFixed(2),
      f.repDate,
      f.daysApart,
      f.repAction,
      f.risk,
    ].map(_wsCell).join(',')),
    [],
    ['','TOTAL DISALLOWED LOSS',flags.reduce((s,f) => s+(f.lossAmount||0),0).toFixed(2)].map(_wsCell).join(','),
  ];
  const dateTag = (dateFrom || dateTo) ? `_${(dateFrom||'').replace(/-/g,'')}-${(dateTo||'').replace(/-/g,'')}` : '';
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `TGCapital_WashSales${dateTag}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── XLSX Export ────────────────────────────────────────
function wsExportXLSX() {
  const flags = _wsGetFilteredFlags();
  if (!flags.length) { alert('No wash sale flags to export.'); return; }
  const { dateFrom, dateTo } = wsState;
  const wb = XLSX.utils.book_new();

  // Sheet 1: Flag detail
  const header  = ['Symbol','Loss Trade Date','Loss Amount ($)','Repurchase Date','Days Apart','Repurchase Action','Risk Level'];
  const data    = flags.map(f => [f.symbol, f.lossDate, f.lossAmount||0, f.repDate, f.daysApart, f.repAction, f.risk]);
  const totals  = ['TOTALS','',flags.reduce((s,f) => s+(f.lossAmount||0),0),'','','',''];
  const ws1 = XLSX.utils.aoa_to_sheet([
    ['TGCapital — Wash Sale Flags'],
    [`Period: ${dateFrom || 'start'} to ${dateTo || 'present'}   Generated: ${new Date().toLocaleDateString()}`],
    [],
    header,
    ...data,
    [],
    totals,
  ]);
  ws1['!cols'] = [{wch:10},{wch:16},{wch:16},{wch:16},{wch:12},{wch:20},{wch:11}];
  XLSX.utils.book_append_sheet(wb, ws1, 'Wash Sale Flags');

  // Sheet 2: By-symbol summary
  const symMap = {};
  for (const f of flags) {
    if (!symMap[f.symbol]) symMap[f.symbol] = { count: 0, totalLoss: 0, highestRisk: 'LOW' };
    symMap[f.symbol].count++;
    symMap[f.symbol].totalLoss += f.lossAmount || 0;
    const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    if ((riskOrder[f.risk]??9) < (riskOrder[symMap[f.symbol].highestRisk]??9)) symMap[f.symbol].highestRisk = f.risk;
  }
  const symRows = Object.entries(symMap).sort((a,b) => a[1].totalLoss - b[1].totalLoss);
  const ws2 = XLSX.utils.aoa_to_sheet([
    ['Symbol','Flags','Total Disallowed Loss ($)','Highest Risk'],
    ...symRows.map(([sym,g]) => [sym, g.count, g.totalLoss, g.highestRisk]),
  ]);
  ws2['!cols'] = [{wch:10},{wch:7},{wch:24},{wch:13}];
  XLSX.utils.book_append_sheet(wb, ws2, 'By Symbol');

  const dateTag = (dateFrom||dateTo) ? `_${(dateFrom||'').replace(/-/g,'')}-${(dateTo||'').replace(/-/g,'')}` : '';
  XLSX.writeFile(wb, `TGCapital_WashSales${dateTag}.xlsx`);
}
