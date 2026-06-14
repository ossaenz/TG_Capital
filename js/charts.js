// ════════════════════════════════════════════════════════
// CHARTS
// ════════════════════════════════════════════════════════
let pnlChartInst = null, symbolChartInst = null, typeChartInst = null;
let performanceChartInst = null;
let performancePeriod = 'daily';
let performanceInstruments = 'options-only';
let performanceDateStart = null;
let performanceDateEnd = null;
let performanceSymbolFilter = '';
let performanceDefaultYearApplied = false;

// Dashboard filtering
let dashboardDateStart = null;
let dashboardDateEnd = null;
let dashboardInstruments = 'options-only';  // 'options-only' or 'all'

function populateYearSelects() {
  // Determine year range: from oldest data to current year
  const allDates = [
    ...db.transactions.map(t => t.date || ''),
    ...db.trades?.map(t => t.openDate || '') || [],
    ...db.trades?.map(t => t.closeDate || '') || []
  ].filter(d => d);
  
  let minYear = new Date().getUTCFullYear();
  let maxYear = new Date().getUTCFullYear();
  
  if (allDates.length > 0) {
    const years = allDates.map(d => parseInt(d.substring(0, 4))).filter(y => !isNaN(y));
    if (years.length > 0) {
      minYear = Math.min(...years);
      maxYear = Math.max(...years);
    }
  }
  
  // Generate years from minYear to maxYear (inclusive), in descending order
  const years = [];
  for (let y = maxYear; y >= minYear; y--) {
    years.push(y);
  }
  
  // Populate both selects
  [document.getElementById('dashboardYearSelect'), document.getElementById('perfYearSelect'),
   document.getElementById('closedYearSelect'),   document.getElementById('tradeYearSelect'),
   document.getElementById('openYearSelect')].forEach(select => {
    if (!select) return;
    // Keep 'All Years' option, remove old options
    const allYearsOption = select.querySelector('option[value=""]');
    while (select.options.length > 1) select.remove(1);
    
    // Add year options
    for (const year of years) {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      select.appendChild(option);
    }
  });

  // Default Performance tab to the most recent year that has closed trade data
  if (!performanceDefaultYearApplied && years.length > 0) {
    const closedYears = new Set(
      (db.transactions || [])
        .map(t => (t.date || '').substring(0, 4))
        .filter(y => y)
    );
    // Pick the most recent year that has data; fall back to most recent year in dropdown
    const defaultYear = years.find(y => closedYears.has(String(y))) || years[0];
    const perfSel = document.getElementById('perfYearSelect');
    if (perfSel && defaultYear) {
      perfSel.value = String(defaultYear);
      performanceDateStart = `${defaultYear}-01-01`;
      performanceDateEnd = `${defaultYear}-12-31`;
      performanceDefaultYearApplied = true;
      updatePerformanceFilterLabel();
    }
  }
}

function renderCharts(closedTrades) {
  // P&L curve (cumulative, by date)
  const sorted = [...closedTrades].sort((a, b) => (a.closeDate || '').localeCompare(b.closeDate || ''));
  let cum = 0;
  const pnlLabels = [], pnlData = [];
  for (const t of sorted) {
    cum += t.netPnl || 0;
    pnlLabels.push(t.closeDate || '');
    pnlData.push(parseFloat(cum.toFixed(2)));
  }

  if (pnlChartInst) pnlChartInst.destroy();
  const color = cum >= 0 ? '#3dd68c' : '#f07070';
  pnlChartInst = new Chart(document.getElementById('pnlChart'), {
    type: 'line',
    data: { labels: pnlLabels, datasets: [{ label: 'Cumulative P&L', data: pnlData, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: '#6b7688', font: { family: 'JetBrains Mono', size: 10 } }, grid: { color: '#2e3440' } },
        y: { ticks: { color: '#6b7688', font: { family: 'JetBrains Mono', size: 10 }, callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3440' } }
      }
    }
  });
  document.getElementById('pnlChartSub').textContent = pnlLabels.length ? `${pnlLabels[0]} → ${pnlLabels[pnlLabels.length - 1]}` : '—';

  // P&L by underlying
  const bySymbol = {};
  for (const t of closedTrades) {
    const k = t.symbol.trim().split(' ')[0];
    bySymbol[k] = (bySymbol[k] || 0) + (t.netPnl || 0);
  }
  const symEntries = Object.entries(bySymbol).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10);

  if (symbolChartInst) symbolChartInst.destroy();
  symbolChartInst = new Chart(document.getElementById('symbolChart'), {
    type: 'bar',
    data: {
      labels: symEntries.map(e => e[0]),
      datasets: [{
        data: symEntries.map(e => parseFloat(e[1].toFixed(2))),
        backgroundColor: symEntries.map(e => e[1] >= 0 ? '#3dd68c55' : '#f0707055'),
        borderColor: symEntries.map(e => e[1] >= 0 ? '#3dd68c' : '#f07070'),
        borderWidth: 1,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#6b7688', font: { family: 'JetBrains Mono', size: 10 } }, grid: { color: '#2e3440' } },
        y: { ticks: { color: '#6b7688', font: { family: 'JetBrains Mono', size: 10 }, callback: v => '$' + v.toLocaleString() }, grid: { color: '#2e3440' } }
      }
    }
  });

  // Trade type breakdown
  const actionCounts = {};
  for (const t of db.transactions) {
    const a = t.action || 'Other';
    actionCounts[a] = (actionCounts[a] || 0) + 1;
  }
  const typeEntries = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const palette = ['#4f8ef7','#3dd68c','#f07070','#f0b060','#b07ef0','#5ccfcf','#a8b0c0'];

  if (typeChartInst) typeChartInst.destroy();
  typeChartInst = new Chart(document.getElementById('typeChart'), {
    type: 'doughnut',
    data: {
      labels: typeEntries.map(e => e[0]),
      datasets: [{ data: typeEntries.map(e => e[1]), backgroundColor: palette, borderColor: '#141618', borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'right', labels: { color: '#a8b0c0', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 10 } }
      }
    }
  });
}

function renderPerformanceChart(rows) {
  if (!rows || !rows.length) {
    if (performanceChartInst) performanceChartInst.destroy();
    performanceChartInst = null;
    return;
  }

  // Sort rows by period key to ensure chronological order
  const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  
  // Build cumulative P&L and label
  let cumPnl = 0;
  const labels = sorted.map(r => periodLabel(r.key, performancePeriod));
  const cumulativeData = sorted.map(r => {
    cumPnl += r.pnl;
    return cumPnl;
  });
  
  const chartColors = cumulativeData.map(v => v >= 0 ? 'rgba(132, 204, 22, 0.8)' : 'rgba(240, 112, 112, 0.8)');
  const borderColor = cumulativeData.map(v => v >= 0 ? '#84cc16' : '#f07070');

  if (performanceChartInst) performanceChartInst.destroy();
  performanceChartInst = new Chart(document.getElementById('performanceChart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Cumulative P&L',
        data: cumulativeData,
        borderColor: '#84cc16',
        backgroundColor: 'rgba(132, 204, 22, 0.1)',
        fill: true,
        tension: 0.2,
        pointRadius: 4,
        pointBackgroundColor: chartColors,
        pointBorderColor: '#84cc16',
        pointBorderWidth: 1,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#c0c3ca', font: { family: 'JetBrains Mono', size: 11 } } },
        tooltip: {
          backgroundColor: 'rgba(20, 22, 24, 0.95)',
          titleColor: '#3dd68c',
          bodyColor: '#c0c3ca',
          borderColor: '#2e3440',
          borderWidth: 1,
          callbacks: {
            label: ctx => {
              const val = ctx.parsed.y || 0;
              return fmt$(val);
            }
          }
        }
      },
      scales: {
        y: {
          ticks: { color: '#6b7688', font: { family: 'JetBrains Mono', size: 10 }, callback: v => fmt$(v) },
          grid: { color: '#2e3440' },
          border: { color: '#2e3440' }
        },
        x: {
          ticks: { color: '#6b7688', font: { family: 'JetBrains Mono', size: 10 } },
          grid: { color: '#2e3440' },
          border: { color: '#2e3440' }
        }
      }
    }
  });
}
