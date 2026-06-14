function applyDashboardFilter() {
  const yearSel = document.getElementById('dashboardYearSelect').value;
  const startDate = document.getElementById('dashboardDateStart').value;
  const endDate = document.getElementById('dashboardDateEnd').value;
  
  if (yearSel) {
    dashboardDateStart = `${yearSel}-01-01`;
    dashboardDateEnd = `${yearSel}-12-31`;
  } else {
    dashboardDateStart = startDate || null;
    dashboardDateEnd = endDate || null;
  }
  
  updateDashboardFilterLabel();
  renderDashboard();
}

function resetDashboardFilter() {
  dashboardDateStart = null;
  dashboardDateEnd = null;
  document.getElementById('dashboardYearSelect').value = '';
  document.getElementById('dashboardDateStart').value = '';
  document.getElementById('dashboardDateEnd').value = '';
  updateDashboardFilterLabel();
  renderDashboard();
}

function updateDashboardFilterLabel() {
  const label = document.getElementById('dashboardFilterLabel');
  if (dashboardDateStart && dashboardDateEnd) {
    label.textContent = `Viewing: ${dashboardDateStart} to ${dashboardDateEnd}`;
  } else if (dashboardDateStart) {
    label.textContent = `Viewing: from ${dashboardDateStart}`;
  } else if (dashboardDateEnd) {
    label.textContent = `Viewing: until ${dashboardDateEnd}`;
  } else {
    label.textContent = 'Viewing: All Years';
  }
}

function setDashboardInstruments(instruments, btn) {
  dashboardInstruments = instruments;
  document.querySelectorAll('#dash-opts-only, #dash-all-inst').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDashboard();
}


function renderDashboard() {
  const stats = computeStatsByDateRange(dashboardDateStart, dashboardDateEnd);
  const {
    realized, fees, premiumCollected, winRate, openPositions, closedTrades, optionClosed, washFlags,
    optionPnl, stockPnl, dividendTotal, interestTotal, dividendCount,
    expiredTrades, btcTrades, assignedTrades, expiredPnl, btcPnl,
    assignedPuts, assignedCalls, effectiveCostBasis,
    profitFactor, avgHoldDays, bestTrade, worstTrade, premiumAtRisk,
    avgWin, avgLoss,
    taxOptions, taxOptionsBase, effectiveOptRate, sec1256Pnl, equityOptPnl,
    taxStock, STCG_RATE, SEC1256_RATE,
    taxDivTotal, taxDivBase, taxDivQual, taxDivNonQual, qualDivs, nonQualDivs, effectiveDivRate, LTCG_RATE,
  } = stats;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const setColor = (id, color) => { const el = document.getElementById(id); if (el) el.style.color = color; };

  // ── GROUP 1: P&L Summary ──────────────────────────────
  const instLabel = dashboardInstruments === 'all' ? 'Options + Stock + Dividends' : 'Closed options only';
  const realizedEl = document.getElementById('kpi-realized');
  realizedEl.textContent = fmt$(realized);
  realizedEl.className   = 'dash-kpi-value lg ' + (realized >= 0 ? 'pos g' : 'pos r');
  set('kpi-realized-sub', instLabel);

  // P&L breakdown sub-row — show in all-instruments mode; hide in options-only
  const breakdownEl = document.getElementById('kpi-pnl-breakdown');
  if (breakdownEl) breakdownEl.style.display = dashboardInstruments === 'all' ? 'flex' : 'none';
  const optPnlEl = document.getElementById('kpi-opt-pnl');
  if (optPnlEl) { optPnlEl.textContent = fmt$(optionPnl); optPnlEl.style.color = optionPnl >= 0 ? 'var(--green)' : 'var(--red)'; }
  const stkPnlEl = document.getElementById('kpi-stk-pnl');
  if (stkPnlEl) { stkPnlEl.textContent = fmt$(stockPnl); stkPnlEl.style.color = stockPnl >= 0 ? 'var(--green)' : 'var(--red)'; }
  const divPnlEl = document.getElementById('kpi-div-pnl');
  if (divPnlEl) { divPnlEl.textContent = fmt$(dividendTotal); divPnlEl.style.color = dividendTotal >= 0 ? 'var(--teal)' : 'var(--red)'; }
  const intPnlEl = document.getElementById('kpi-int-pnl');
  if (intPnlEl) { intPnlEl.textContent = fmt$(interestTotal); intPnlEl.style.color = 'var(--teal)'; }

  set('kpi-premium', fmt$(premiumCollected));
  const feesEl = document.getElementById('kpi-fees');
  feesEl.textContent = fmt$(-fees);
  feesEl.className = 'dash-kpi-value pos r';

  const incomeTotal = dividendTotal + interestTotal;
  const incomeEl = document.getElementById('kpi-income');
  incomeEl.textContent = fmt$(incomeTotal);
  incomeEl.style.color = incomeTotal >= 0 ? 'var(--teal)' : 'var(--red)';
  set('kpi-income-sub', dividendCount > 0 ? `${dividendCount} events` : 'No events in period');

  // ── Tax estimate tiles ─────────────────────────────────
  const taxOptEl = document.getElementById('kpi-tax-options');
  if (taxOptionsBase > 0) {
    taxOptEl.textContent = fmt$(taxOptions);
    taxOptEl.style.color = 'var(--red)';
  } else {
    taxOptEl.textContent = optionPnl <= 0 ? 'No gain' : '—';
    taxOptEl.style.color = 'var(--text2)';
  }
  set('kpi-tax-options-rate', (effectiveOptRate * 100).toFixed(1) + '%');
  set('kpi-tax-options-base', fmt$(taxOptionsBase));
  // Note line: mention Sec 1256 if any detected, otherwise plain STCG
  set('kpi-tax-options-note', sec1256Pnl > 0
    ? `${(STCG_RATE * 100).toFixed(0)}% STCG · Sec.1256 ${(SEC1256_RATE * 100).toFixed(1)}% blended`
    : `${(STCG_RATE * 100).toFixed(0)}% short-term (ordinary income)`);

  const taxStkEl = document.getElementById('kpi-tax-stock');
  if (stockPnl > 0) {
    taxStkEl.textContent = fmt$(taxStock);
    taxStkEl.style.color = 'var(--red)';
  } else {
    taxStkEl.textContent = stockPnl <= 0 ? 'No gain' : '—';
    taxStkEl.style.color = 'var(--text2)';
  }
  set('kpi-tax-stock-rate', (STCG_RATE * 100).toFixed(0) + '%');
  set('kpi-tax-stock-base', fmt$(stockPnl > 0 ? stockPnl : 0));

  // ── Dividend tax tile ──────────────────────────────────
  const taxDivEl = document.getElementById('kpi-tax-div');
  if (taxDivBase > 0) {
    taxDivEl.textContent = fmt$(taxDivTotal);
    taxDivEl.style.color = 'var(--red)';
  } else {
    taxDivEl.textContent = (dividendTotal <= 0) ? 'No gain' : '—';
    taxDivEl.style.color = 'var(--text2)';
  }
  // Sub-row: show qualified and non-qualified amounts separately
  const qualEl = document.getElementById('kpi-tax-div-qual');
  if (qualEl) {
    qualEl.textContent = qualDivs > 0 ? fmt$(taxDivQual) : '—';
    qualEl.style.color = qualDivs > 0 ? 'var(--red)' : 'var(--text2)';
  }
  const nonQualEl = document.getElementById('kpi-tax-div-nonqual');
  if (nonQualEl) {
    nonQualEl.textContent = nonQualDivs > 0 ? fmt$(taxDivNonQual) : '—';
    nonQualEl.style.color = nonQualDivs > 0 ? 'var(--red)' : 'var(--text2)';
  }
  set('kpi-tax-div-note',
    qualDivs > 0 && nonQualDivs > 0
      ? `${fmt$(qualDivs)} qual (${(LTCG_RATE*100).toFixed(0)}%) · ${fmt$(nonQualDivs)} non-qual (${(STCG_RATE*100).toFixed(0)}%)`
      : qualDivs > 0
      ? `${fmt$(qualDivs)} qualified · ${(LTCG_RATE*100).toFixed(0)}% rate`
      : nonQualDivs > 0
      ? `${fmt$(nonQualDivs)} non-qualified · ${(STCG_RATE*100).toFixed(0)}% rate`
      : 'No dividend income in period'
  );

  // ── GROUP 2: Options Performance ──────────────────────
  const wrEl = document.getElementById('kpi-wr');
  wrEl.textContent = winRate !== null ? (winRate * 100).toFixed(1) + '%' : '—';
  wrEl.style.color = winRate === null ? 'var(--text2)' : winRate >= 0.5 ? 'var(--green)' : 'var(--red)';
  set('kpi-wr-sub', optionClosed.length > 0 ? `${optionClosed.filter(t=>(t.netPnl||0)>0).length}W · ${optionClosed.filter(t=>(t.netPnl||0)<0).length}L · ${optionClosed.length} trades` : 'No closed trades');

  const pfEl = document.getElementById('kpi-pf');
  pfEl.textContent = profitFactor !== null ? profitFactor.toFixed(2) : '—';
  pfEl.style.color = profitFactor === null ? 'var(--text2)' : profitFactor >= 2 ? 'var(--green)' : profitFactor >= 1 ? 'var(--amber)' : 'var(--red)';

  const avgWinEl = document.getElementById('kpi-avg-win');
  avgWinEl.textContent = avgWin ? fmt$(avgWin) : '—';
  avgWinEl.style.color = 'var(--green)';
  const avgLossEl = document.getElementById('kpi-avg-loss');
  avgLossEl.textContent = avgLoss ? fmt$(avgLoss) : '—';
  avgLossEl.style.color = 'var(--red)';

  const holdEl = document.getElementById('kpi-hold');
  holdEl.textContent = avgHoldDays !== null ? Math.round(avgHoldDays) + 'd' : '—';
  holdEl.style.color = avgHoldDays !== null ? 'var(--purple)' : 'var(--text2)';

  const bestEl = document.getElementById('kpi-best');
  bestEl.textContent = bestTrade ? fmt$(bestTrade.netPnl) : '—';
  bestEl.style.color = bestTrade && (bestTrade.netPnl || 0) > 0 ? 'var(--green)' : 'var(--text2)';
  set('kpi-best-sub', bestTrade ? (bestTrade.underlying || bestTrade.symbol.split(' ')[0]) + ' · ' + (bestTrade.closeDate || '') : 'No trades');

  const worstEl = document.getElementById('kpi-worst');
  worstEl.textContent = worstTrade ? fmt$(worstTrade.netPnl) : '—';
  worstEl.style.color = worstTrade && (worstTrade.netPnl || 0) < 0 ? 'var(--red)' : 'var(--text2)';
  set('kpi-worst-sub', worstTrade ? (worstTrade.underlying || worstTrade.symbol.split(' ')[0]) + ' · ' + (worstTrade.closeDate || '') : 'No trades');

  // ── GROUP 3: How Options Closed ────────────────────────
  const total = optionClosed.length;
  const expiredPnlEl = document.getElementById('kpi-expired-pnl');
  expiredPnlEl.textContent = fmt$(expiredPnl);
  expiredPnlEl.style.color = expiredPnl >= 0 ? 'var(--green)' : 'var(--red)';
  set('kpi-expired-count', expiredTrades.length);
  set('kpi-expired-pct', total > 0 ? (expiredTrades.length / total * 100).toFixed(0) + '%' : '—');

  const btcPnlEl = document.getElementById('kpi-btc-pnl');
  btcPnlEl.textContent = fmt$(btcPnl);
  btcPnlEl.style.color = btcPnl >= 0 ? 'var(--green)' : 'var(--red)';
  set('kpi-btc-count', btcTrades.length);
  set('kpi-btc-pct', total > 0 ? (btcTrades.length / total * 100).toFixed(0) + '%' : '—');

  const asgnPutsEl = document.getElementById('kpi-asgn-puts');
  asgnPutsEl.textContent = assignedPuts.length;
  asgnPutsEl.style.color = assignedPuts.length > 0 ? 'var(--amber)' : 'var(--text2)';
  set('kpi-asgn-puts-sub', assignedPuts.length > 0
    ? `${assignedPuts.map(t => t.underlying || t.symbol.split(' ')[0]).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}`
    : 'None in period');

  const asgnCallsEl = document.getElementById('kpi-asgn-calls');
  asgnCallsEl.textContent = assignedCalls.length;
  asgnCallsEl.style.color = assignedCalls.length > 0 ? 'var(--amber)' : 'var(--text2)';

  const cbEl = document.getElementById('kpi-cost-basis');
  cbEl.textContent = effectiveCostBasis > 0 ? fmt$(effectiveCostBasis) : assignedPuts.length === 0 ? '—' : '$0';
  cbEl.style.color = effectiveCostBasis > 0 ? 'var(--amber)' : 'var(--text2)';

  // ── GROUP 4: Exposure & Risk ───────────────────────────
  const openEl = document.getElementById('kpi-open');
  openEl.textContent = openPositions.length;
  openEl.style.color = openPositions.length > 0 ? 'var(--teal)' : 'var(--text2)';

  const totalTradesEl = document.getElementById('kpi-total-trades');
  const totalTradesSubEl = document.getElementById('kpi-total-trades-sub');
  const totalTrades = dashboardInstruments === 'options-only' ? optionClosed.length : closedTrades.length;
  totalTradesEl.textContent = totalTrades;
  totalTradesEl.style.color = totalTrades > 0 ? 'var(--purple)' : 'var(--text2)';
  totalTradesSubEl.textContent = dashboardInstruments === 'options-only' ? 'Options closed' : 'All closed trades';

  // ── Trade Breakdown ────────────────────────────────────
  const allTxns = db.transactions.filter(t => {
    if (dashboardDateStart || dashboardDateEnd) {
      const d = t.date || t.rawDate || '';
      if (dashboardDateStart && d < dashboardDateStart) return false;
      if (dashboardDateEnd && d > dashboardDateEnd) return false;
    }
    return true;
  });

  const countByAction = {};
  allTxns.forEach(t => {
    const action = t.action || '';
    countByAction[action] = (countByAction[action] || 0) + 1;
  });

  const setTradeCount = (id, subId, action, label) => {
    const count = countByAction[action] || 0;
    const el = document.getElementById(id);
    const subEl = document.getElementById(subId);
    if (el) {
      el.textContent = count;
      el.style.color = count > 0 ? 'var(--text0)' : 'var(--text2)';
    }
    if (subEl) subEl.textContent = label;
  };

  setTradeCount('kpi-sto', 'kpi-sto-sub', 'Sell to Open', 'Option contracts sold');
  setTradeCount('kpi-btc', 'kpi-btc-sub', 'Buy to Close', 'Options bought back');
  setTradeCount('kpi-bto', 'kpi-bto-sub', 'Buy to Open', 'Option contracts bought');
  setTradeCount('kpi-stc', 'kpi-stc-sub', 'Sell to Close', 'Options sold to close');
  setTradeCount('kpi-stock-buy', 'kpi-stock-buy-sub', 'Buy', 'Stock purchases');
  setTradeCount('kpi-stock-sell', 'kpi-stock-sell-sub', 'Sell', 'Stock sales');
  setTradeCount('kpi-assigned', 'kpi-assigned-sub', 'Assigned', 'Assignment closures');
  setTradeCount('kpi-expired', 'kpi-expired-sub', 'Expired', 'Expirations');

  const expEl = document.getElementById('kpi-exposure');
  expEl.textContent = premiumAtRisk > 0 ? fmt$(premiumAtRisk) : '—';
  expEl.style.color = premiumAtRisk > 0 ? 'var(--amber)' : 'var(--text2)';

  const washEl = document.getElementById('kpi-wash');
  washEl.textContent = washFlags.length;
  washEl.style.color = washFlags.length > 0 ? 'var(--red)' : 'var(--text2)';

  // ── Topbar ─────────────────────────────────────────────
  document.getElementById('ts-realized').textContent = fmt$(realized);
  document.getElementById('ts-realized').className = 'tstat-val pos ' + pnlClass(realized);
  document.getElementById('ts-open').textContent = openPositions.length;
  const isFiltered = !!(dashboardDateStart || dashboardDateEnd);
  const displayedTrades = dashboardInstruments === 'options-only' ? optionClosed : closedTrades;
  document.getElementById('ts-total').textContent = isFiltered ? displayedTrades.length : db.transactions.length;
  document.getElementById('ts-total-label').textContent = isFiltered ? 'Closed in Range' : 'Total Records';
  document.getElementById('ts-wr').textContent = winRate !== null ? (winRate * 100).toFixed(1) + '%' : '—';

  // ── Recent closed trades table ─────────────────────────
  let recentTrades = dashboardInstruments === 'options-only' ? optionClosed : closedTrades;
  const recent = [...recentTrades].sort((a, b) => (b.closeDate || '').localeCompare(a.closeDate || '')).slice(0, 30);
  const tbody = document.querySelector('#recentTable tbody');
  if (recent.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No closed trades yet.</td></tr>';
  } else {
    tbody.innerHTML = recent.map(t => {
      const viaBadge = t.via === 'expired'
        ? '<span class="badge badge-expired">EXPIRED</span>'
        : t.via === 'assigned'
        ? '<span class="badge badge-assigned">ASSIGNED</span>'
        : t.via === 'sold'
        ? '<span class="badge badge-stock">SOLD</span>'
        : statusBadge('closed');
      const closedForLabel = t.via === 'expired'
        ? '<span style="color:var(--text2)">$0.00</span>'
        : t.closePrice != null
        ? fmt$(t.closePrice) + (t.via === 'assigned' ? ' (strike)' : t.instrument === 'option' ? '/contract' : '/share')
        : '—';
      return `<tr>
        <td>${t.closeDate || '—'}</td>
        <td><span style="font-family:var(--mono);font-weight:700">${t.underlying || t.symbol.split(' ')[0]}</span>
          ${t.instrument === 'option' ? `<br><span style="font-size:10px;color:var(--text2);font-family:var(--mono)">${t.optionType === 'put' ? 'PUT' : 'CALL'} $${t.strike} exp ${t.expiry}</span>` : ''}
        </td>
        <td>${instBadge(t.instrument, t.optionType)}</td>
        <td>${t.openDate || '—'}</td>
        <td class="r"><span class="pos g">${fmt$(Math.abs(t.openCredit || 0))}</span></td>
        <td class="r">${closedForLabel}</td>
        <td>${viaBadge}</td>
        <td class="r"><span style="color:var(--red)">${t.fees > 0 ? '-' + fmt$(t.fees) : '—'}</span></td>
        <td class="r"><span class="pos ${pnlClass(t.netPnl)}" style="font-weight:700">${fmt$(t.netPnl)}</span></td>
      </tr>`;
    }).join('');
  }

  // Toggle chart panel: show empty state when no data, open panel when data arrives
  const chartEmpty = document.getElementById('chartEmptyState');
  const chartContent = document.getElementById('chartContent');
  const chartsPanel = document.getElementById('chartsPanel');
  if (optionClosed.length > 0) {
    if (chartEmpty) chartEmpty.style.display = 'none';
    if (chartContent) chartContent.style.display = '';
    if (chartsPanel && !chartsPanel.open) chartsPanel.open = true;
    renderCharts(optionClosed);
  } else {
    if (chartEmpty) chartEmpty.style.display = '';
    if (chartContent) chartContent.style.display = 'none';
  }
}
