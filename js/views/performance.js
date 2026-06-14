function setPerformancePeriod(period, btn) {
  performancePeriod = period;
  document.querySelectorAll('#view-performance .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPerformance();
}

function setPerformanceInstruments(instruments, btn) {
  performanceInstruments = instruments;
  document.querySelectorAll('#perf-opts-only, #perf-all-inst').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPerformance();
}

function applyPerformanceFilter() {
  const yearSel = document.getElementById('perfYearSelect').value;
  const startDate = document.getElementById('perfDateStart').value;
  const endDate = document.getElementById('perfDateEnd').value;
  const symbolInput = document.getElementById('perfSymfilter').value.toUpperCase().trim();
  
  // Apply year filter if selected
  if (yearSel) {
    performanceDateStart = `${yearSel}-01-01`;
    performanceDateEnd = `${yearSel}-12-31`;
  } else {
    performanceDateStart = startDate || null;
    performanceDateEnd = endDate || null;
  }
  performanceSymbolFilter = symbolInput;
  
  updatePerformanceFilterLabel();
  renderPerformance();
}

function resetPerformanceFilter() {
  performanceDateStart = null;
  performanceDateEnd = null;
  performanceSymbolFilter = '';
  document.getElementById('perfYearSelect').value = '';
  document.getElementById('perfDateStart').value = '';
  document.getElementById('perfDateEnd').value = '';
  document.getElementById('perfSymfilter').value = '';
  updatePerformanceFilterLabel();
  renderPerformance();
}

function updatePerformanceFilterLabel() {
  const label = document.getElementById('perfFilterLabel');
  const parts = [];
  
  if (performanceDateStart || performanceDateEnd) {
    const start = performanceDateStart || '–';
    const end = performanceDateEnd || '–';
    parts.push(`${start} to ${end}`);
  }
  
  if (performanceSymbolFilter) {
    parts.push(`Symbol: ${performanceSymbolFilter}`);
  }
  
  label.textContent = parts.length > 0 ? parts.join(' | ') : 'All filters active';
}


function renderPerformance() {
  const { optionClosed } = computeStats();
  
  // Filter trades by instrument type
  let filteredTrades = optionClosed;
  if (performanceInstruments === 'all') {
    // Include all closed trades (options + stock/ETF)
    const allTrades = (db.trades || []).filter(t => t.status === 'closed' && t.closeDate && t.netPnl !== undefined);
    filteredTrades = [...optionClosed, ...allTrades.filter(t => !t.type || t.type !== 'option')];
  }

  // Filter trades by date range
  if (performanceDateStart || performanceDateEnd) {
    filteredTrades = filteredTrades.filter(t => {
      const closeDate = t.closeDate || '';
      if (performanceDateStart && closeDate < performanceDateStart) return false;
      if (performanceDateEnd && closeDate > performanceDateEnd) return false;
      return true;
    });
  }

  // Filter trades by symbol
  if (performanceSymbolFilter) {
    filteredTrades = filteredTrades.filter(t => {
      const symbol = (t.symbol || '').toUpperCase();
      const underlying = (t.underlying || '').toUpperCase();
      return symbol.includes(performanceSymbolFilter) || underlying.includes(performanceSymbolFilter);
    });
  }

  // KPIs should show current period stats (today/this week/month/year) from ALL trades, not filtered trades
  let unfilterredTrades = optionClosed;
  if (performanceInstruments === 'all') {
    const allTrades = (db.trades || []).filter(t => t.status === 'closed' && t.closeDate && t.netPnl !== undefined);
    unfilterredTrades = [...optionClosed, ...allTrades.filter(t => !t.type || t.type !== 'option')];
  }
  const day = currentPeriodMetrics(unfilterredTrades, 'daily');
  const week = currentPeriodMetrics(unfilterredTrades, 'weekly');
  const month = currentPeriodMetrics(unfilterredTrades, 'monthly');
  const year = currentPeriodMetrics(unfilterredTrades, 'yearly');

  const setKpi = (prefix, m, granularity) => {
    const el = document.getElementById(prefix + '-pnl');
    el.textContent = fmt$(m.pnl);
    el.className = 'kpi-value pos ' + pnlClass(m.pnl);
    document.getElementById(prefix + '-sub').textContent = `${periodLabel(m.key, granularity)} · ${m.count} trades`;
  };
  setKpi('perf-day', day, 'daily');
  setKpi('perf-week', week, 'weekly');
  setKpi('perf-month', month, 'monthly');
  setKpi('perf-year', year, 'yearly');

  const rows = bucketPerformance(filteredTrades, performancePeriod, performanceDateStart, performanceDateEnd);
  const tbody = document.querySelector('#performanceTable tbody');
  const instLabel = performanceInstruments === 'all' ? 'all instruments' : 'options';
  const dateRangeInfo = (performanceDateStart || performanceDateEnd) 
    ? ` (${performanceDateStart || '–'}  to  ${performanceDateEnd || '–'})`
    : '';
  document.getElementById('perfSummarySub').textContent = rows.length
    ? `Showing ${performancePeriod} performance (${instLabel}) across ${rows.length} periods${dateRangeInfo}`
    : `No data for ${performancePeriod} performance yet`;

  // Symbol summary tile
  const symTile = document.getElementById('perfSymbolSummary');
  if (performanceSymbolFilter) {
    const allClosed = (db.trades || []).filter(t => t.status === 'closed' && t.closeDate && t.netPnl !== undefined);
    let symTrades = [...optionClosed, ...allClosed.filter(t => !t.type || t.type !== 'option')];
    if (performanceDateStart || performanceDateEnd) {
      symTrades = symTrades.filter(t => {
        const cd = t.closeDate || '';
        if (performanceDateStart && cd < performanceDateStart) return false;
        if (performanceDateEnd && cd > performanceDateEnd) return false;
        return true;
      });
    }
    symTrades = symTrades.filter(t => {
      const sym = (t.symbol || '').toUpperCase();
      const und = (t.underlying || '').toUpperCase();
      return sym.includes(performanceSymbolFilter) || und.includes(performanceSymbolFilter);
    });
    const symOptTrades   = symTrades.filter(t => t.instrument === 'option');
    const symStockTrades = symTrades.filter(t => t.instrument !== 'option');
    const symOptPnl   = symOptTrades.reduce((s, t) => s + (t.netPnl || 0), 0);
    const symStockPnl = symStockTrades.reduce((s, t) => s + (t.netPnl || 0), 0);
    const symTotalPnl = symOptPnl + symStockPnl;
    document.getElementById('perfSymbolSummaryTitle').textContent = `${performanceSymbolFilter} — P&L Summary`;
    const optEl = document.getElementById('pss-options-pnl');
    optEl.textContent = fmt$(symOptPnl);
    optEl.className = `kpi-value pos ${pnlClass(symOptPnl)}`;
    document.getElementById('pss-options-sub').textContent = `${symOptTrades.length} option trade${symOptTrades.length !== 1 ? 's' : ''}`;
    const stockEl = document.getElementById('pss-stock-pnl');
    stockEl.textContent = fmt$(symStockPnl);
    stockEl.className = `kpi-value pos ${pnlClass(symStockPnl)}`;
    document.getElementById('pss-stock-sub').textContent = `${symStockTrades.length} stock trade${symStockTrades.length !== 1 ? 's' : ''}`;
    const totalEl = document.getElementById('pss-total-pnl');
    totalEl.textContent = fmt$(symTotalPnl);
    totalEl.className = `kpi-value pos ${pnlClass(symTotalPnl)}`;
    document.getElementById('pss-total-sub').textContent = `${symTrades.length} total trade${symTrades.length !== 1 ? 's' : ''}`;
    symTile.style.display = '';
  } else {
    symTile.style.display = 'none';
  }

  // Update range statistics
  updateRangeStats(filteredTrades);

  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No closed trades yet.</td></tr>';
    renderPerformanceChart([]);
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const wr = r.count > 0 ? (r.wins / r.count) * 100 : 0;
    const avg = r.count > 0 ? r.pnl / r.count : 0;
    return `<tr>
      <td>${periodLabel(r.key, performancePeriod)}</td>
      <td class="r">${r.count}</td>
      <td class="r" style="color:var(--green)">${r.wins}</td>
      <td class="r" style="color:var(--red)">${r.losses}</td>
      <td class="r" style="color:${wr >= 50 ? 'var(--green)' : 'var(--red)'}">${wr.toFixed(1)}%</td>
      <td class="r"><span class="pos ${pnlClass(r.pnl)}">${fmt$(r.pnl)}</span></td>
      <td class="r"><span class="pos ${pnlClass(avg)}">${fmt$(avg)}</span></td>
    </tr>`;
  }).join('');
  
  renderPerformanceChart(rows);
}

