// ════════════════════════════════════════════════════════
// ANALYTICS
// ════════════════════════════════════════════════════════
function computeStats() {
  const { openPositions, closedTrades } = buildPositions();
  const washFlags = detectWashSales();

  // Realized P&L is option-only (strike-based round-trips) to avoid
  // distorting totals when stock cost basis is outside the loaded date range.
  const optionClosed = closedTrades.filter(t => t.instrument === 'option');
  const realized = optionClosed.reduce((s, t) => s + (t.netPnl || 0), 0);
  const fees = db.transactions.reduce((s, t) => s + (t.fees || 0), 0);
  // Premium collected: only from closed/expired/assigned option positions
  // NOT from all STOs (many of which are still open)
  const premiumCollected = closedTrades
    .filter(t => t.instrument === 'option')
    .reduce((s, t) => s + Math.max(0, t.openCredit || 0), 0);
  const assigned = db.transactions.filter(t => t.action === 'Assigned').length;

  const wins = optionClosed.filter(t => (t.netPnl || 0) > 0);
  const losses_arr = optionClosed.filter(t => (t.netPnl || 0) < 0);
  const winRate = optionClosed.length > 0 ? wins.length / optionClosed.length : null;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length : 0;
  const avgLoss = losses_arr.length > 0 ? losses_arr.reduce((s, t) => s + t.netPnl, 0) / losses_arr.length : 0;

  return { realized, fees, premiumCollected, assigned, winRate, avgWin, avgLoss, openPositions, closedTrades, optionClosed, washFlags };
}


// ════════════════════════════════════════════════════════
// RENDER FUNCTIONS
// ════════════════════════════════════════════════════════
function fmt$(v) {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-$' : '$') + str;
}

function pnlClass(v) {
  if (v === null || v === undefined || v === 0) return 'n';
  return v > 0 ? 'g' : 'r';
}

function instBadge(inst, optType) {
  if (inst === 'option') {
    return optType === 'call' ? '<span class="badge badge-call">CALL</span>' : '<span class="badge badge-put">PUT</span>';
  }
  if (inst === 'etf') return '<span class="badge badge-etf">ETF</span>';
  return '<span class="badge badge-stock">STOCK</span>';
}

function statusBadge(s) {
  const map = { open: 'badge-open', closed: 'badge-closed', assigned: 'badge-assigned', expired: 'badge-expired' };
  return `<span class="badge ${map[s] || 'badge-closed'}">${s.toUpperCase()}</span>`;
}

function dirBadge(d) {
  if (!d) return '';
  return d === 'short' ? '<span class="badge badge-short">SHORT</span>' : '<span class="badge badge-long">LONG</span>';
}

function isoWeekParts(dateObj) {
  const d = new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function periodKey(dateStr, granularity) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (granularity === 'daily') return `${y}-${m}-${day}`;
  if (granularity === 'weekly') {
    const w = isoWeekParts(d);
    return `${w.year}-W${String(w.week).padStart(2, '0')}`;
  }
  if (granularity === 'monthly') return `${y}-${m}`;
  return String(y);
}

function periodLabel(key, granularity) {
  if (!key) return '—';
  if (granularity === 'daily') return key;
  if (granularity === 'weekly') return key;
  if (granularity === 'monthly') {
    const [y, m] = key.split('-');
    const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
    return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return key;
}

function bucketPerformance(closedTrades, granularity, dateStart, dateEnd) {
  const buckets = new Map();

  // For daily granularity with date range, pre-generate all days (capped at today)
  if (granularity === 'daily' && dateStart && dateEnd) {
    const d = new Date(dateStart);
    const endDate = new Date(dateEnd);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    // Don't generate buckets for future dates
    const actualEnd = endDate > today ? today : endDate;
    while (d <= actualEnd) {
      const dateStr = d.toISOString().slice(0, 10);
      buckets.set(dateStr, { key: dateStr, pnl: 0, count: 0, wins: 0, losses: 0 });
      d.setDate(d.getDate() + 1);
    }
  }

  // Populate trades into buckets
  for (const t of closedTrades) {
    const key = periodKey(t.closeDate, granularity);
    if (!key) continue;
    if (!buckets.has(key)) {
      buckets.set(key, { key, pnl: 0, count: 0, wins: 0, losses: 0 });
    }
    const b = buckets.get(key);
    const pnl = t.netPnl || 0;
    b.pnl += pnl;
    b.count += 1;
    if (pnl > 0) b.wins += 1;
    if (pnl < 0) b.losses += 1;
  }
  return [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function currentPeriodMetrics(closedTrades, granularity) {
  const now = new Date();
  const utcNow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const key = periodKey(utcNow.toISOString().slice(0, 10), granularity);
  const bucket = bucketPerformance(closedTrades, granularity).find(b => b.key === key);
  return {
    key,
    pnl: bucket ? bucket.pnl : 0,
    count: bucket ? bucket.count : 0,
    wins: bucket ? bucket.wins : 0,
    losses: bucket ? bucket.losses : 0,
  };
}

function computeStatsByDateRange(dateStart, dateEnd) {
  const { openPositions, closedTrades } = buildPositions();
  
  // Filter closed trades by date range
  let filteredTrades = closedTrades;
  if (dateStart || dateEnd) {
    filteredTrades = closedTrades.filter(t => {
      const closeDate = t.closeDate || '';
      if (dateStart && closeDate < dateStart) return false;
      if (dateEnd && closeDate > dateEnd) return false;
      return true;
    });
  }
  
  // Filter open positions by date range (opened on or after dateStart)
  let filteredOpenPositions = openPositions;
  if (dateStart || dateEnd) {
    filteredOpenPositions = openPositions.filter(pos => {
      const openDate = pos.openDate || '';
      if (dateStart && openDate < dateStart) return false;
      if (dateEnd && openDate > dateEnd) return false;
      return true;
    });
  }
  
  // Filter transactions for wash detection FIRST (before using it)
  let txnsForWash = db.transactions;
  if (dateStart || dateEnd) {
    txnsForWash = db.transactions.filter(t => {
      const tDate = t.date || '';
      if (dateStart && tDate < dateStart) return false;
      if (dateEnd && tDate > dateEnd) return false;
      return true;
    });
  }
  
  const washFlags = detectWashSales(txnsForWash);
  
  // Calculate P&L based on instrument filter
  let tradesDirty = filteredTrades;
  if (dashboardInstruments === 'all') {
    // Include all closed trades (options + stock/ETF)
    // BUT: for stocks, only include those with valid openDate (matched trades)
    // Skip stocks with undefined openDate (carry-in/unmatched positions)
    tradesDirty = filteredTrades.filter(t => {
      if (t.instrument === 'option') return true;  // All options OK
      // For stocks: must have openDate (matched) AND both dates within range
      if (t.instrument !== 'option') {
        if (!t.openDate) return false;  // No open date = unmatched, exclude
        if (dateStart && t.openDate < dateStart) return false;  // Buy before period
      }
      return true;
    });
  } else {
    // Option only
    tradesDirty = filteredTrades.filter(t => t.instrument === 'option');
  }
  
  const optionClosed = tradesDirty.filter(t => t.instrument === 'option');
  let realized = tradesDirty.reduce((s, t) => s + (t.netPnl || 0), 0);
  
  // Filter transactions for fees and premium
  let filteredTxns = db.transactions;
  if (dateStart || dateEnd) {
    filteredTxns = db.transactions.filter(t => {
      const tDate = t.date || '';
      if (dateStart && tDate < dateStart) return false;
      if (dateEnd && tDate > dateEnd) return false;
      return true;
    });
  }
  
  const fees = filteredTxns.reduce((s, t) => s + (t.fees || 0), 0);
  
  // Premium collected: sum of openCredit from CLOSED option positions only
  // (These are STOs/similar that were opened and closed within the date range)
  const optionTrades = tradesDirty.filter(t => t.instrument === 'option');
  const premiumCollected = optionTrades.reduce((s, t) => s + Math.max(0, t.openCredit || 0), 0);
  
  // Count assignments from filtered transactions
  const assigned = filteredTxns.filter(t => t.action === 'Assigned').length;
  
  // In "all" mode, include dividends in realized P&L
  if (dashboardInstruments === 'all') {
    const dividends = filteredTxns
      .filter(t => t.action === 'Cash Dividend')
      .reduce((s, t) => s + (t.amount || 0), 0);
    realized += dividends;
  }

  const wins = optionClosed.filter(t => (t.netPnl || 0) > 0);
  const losses_arr = optionClosed.filter(t => (t.netPnl || 0) < 0);
  const winRate = optionClosed.length > 0 ? wins.length / optionClosed.length : null;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length : 0;
  const avgLoss = losses_arr.length > 0 ? losses_arr.reduce((s, t) => s + t.netPnl, 0) / losses_arr.length : 0;

  // ── Extended stats ────────────────────────────────────
  // P&L breakdown
  const optionPnl = optionClosed.reduce((s, t) => s + (t.netPnl || 0), 0);
  const stockPnl  = tradesDirty.filter(t => t.instrument !== 'option').reduce((s, t) => s + (t.netPnl || 0), 0);
  const dividendTotal = filteredTxns
    .filter(t => ['Cash Dividend','Pr Yr Cash Div','Pr Yr Non-Qual Div'].includes(t.action))
    .reduce((s, t) => s + (t.amount || 0), 0);
  const interestTotal = filteredTxns
    .filter(t => t.action === 'Credit Interest')
    .reduce((s, t) => s + (t.amount || 0), 0);
  const dividendCount = filteredTxns.filter(t => ['Cash Dividend','Pr Yr Cash Div','Pr Yr Non-Qual Div','Credit Interest'].includes(t.action)).length;

  // Option close-type breakdown
  const expiredTrades  = optionClosed.filter(t => t.via === 'expired');
  const btcTrades      = optionClosed.filter(t => t.via === 'closed');
  const assignedTrades = optionClosed.filter(t => t.via === 'assigned');
  const expiredPnl     = expiredTrades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const btcPnl         = btcTrades.reduce((s, t) => s + (t.netPnl || 0), 0);

  // Assignment breakdown by type
  const assignedPuts  = assignedTrades.filter(t => t.optionType === 'put');
  const assignedCalls = assignedTrades.filter(t => t.optionType === 'call');
  // Effective cost basis for put assignments: strike × qty × 100 − premium received
  const putAssignmentExposure = assignedPuts.reduce((s, t) => s + ((t.strike || 0) * (t.qty || 1) * 100), 0);
  const putPremiumOffset      = assignedPuts.reduce((s, t) => s + (t.openCredit || 0), 0);
  const effectiveCostBasis    = putAssignmentExposure - putPremiumOffset;

  // Profit factor (gross wins / abs gross losses — options only)
  const grossWins   = wins.reduce((s, t) => s + (t.netPnl || 0), 0);
  const grossLosses = Math.abs(losses_arr.reduce((s, t) => s + (t.netPnl || 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : null;

  // Avg holding period (calendar days, options only)
  const holdingDays = optionClosed
    .filter(t => t.openDate && t.closeDate)
    .map(t => Math.round((new Date(t.closeDate) - new Date(t.openDate)) / 86400000));
  const avgHoldDays = holdingDays.length > 0 ? holdingDays.reduce((s, d) => s + d, 0) / holdingDays.length : null;

  // Best and worst single trade (options)
  const bestTrade  = optionClosed.length > 0 ? optionClosed.reduce((best, t) => (t.netPnl || 0) > (best.netPnl || 0) ? t : best) : null;
  const worstTrade = optionClosed.length > 0 ? optionClosed.reduce((worst, t) => (t.netPnl || 0) < (worst.netPnl || 0) ? t : worst) : null;

  // Max premium at risk (open put positions: strike × qty × 100)
  const openPuts = filteredOpenPositions.filter(p => p.optionType === 'put');
  const premiumAtRisk = openPuts.reduce((s, p) => s + ((p.strike || 0) * (p.qty || 1) * 100), 0);

  // ── Tax estimates ─────────────────────────────────────
  // Section 1256 instruments (cash-settled index options & futures):
  // 60% long-term (20%) + 40% short-term (37%) = 26.8% blended at top bracket.
  const SEC1256_SYMBOLS = new Set(['SPX','SPXW','NDX','NDXP','RUT','VIX','XSP','/ES','/MES','/NQ','/MNQ','/RTY','/M2K']);
  const STCG_RATE  = 0.37;   // top federal short-term bracket
  const LTCG_RATE  = 0.20;   // top federal long-term bracket
  const SEC1256_RATE = (0.60 * LTCG_RATE) + (0.40 * STCG_RATE);  // = 0.268

  // Split option P&L into Sec 1256 vs regular equity options
  const sec1256Pnl  = optionClosed
    .filter(t => SEC1256_SYMBOLS.has((t.underlying || '').toUpperCase()))
    .reduce((s, t) => s + (t.netPnl || 0), 0);
  const equityOptPnl = optionPnl - sec1256Pnl;

  // Estimated tax on options: Sec 1256 at blended rate, everything else at STCG
  const taxOptions = (equityOptPnl > 0 ? equityOptPnl * STCG_RATE : 0)
                   + (sec1256Pnl  > 0 ? sec1256Pnl  * SEC1256_RATE : 0);
  const taxOptionsBase = (equityOptPnl > 0 ? equityOptPnl : 0) + (sec1256Pnl > 0 ? sec1256Pnl : 0);

  // Estimated tax on stock/ETF: short-term (assignments typically held < 1yr)
  const taxStock = stockPnl > 0 ? stockPnl * STCG_RATE : 0;

  // Effective blended rate on options (for display)
  const effectiveOptRate = taxOptionsBase > 0 ? taxOptions / taxOptionsBase : STCG_RATE;

  // ── Dividend tax ──────────────────────────────────────
  // Non-qualified: YieldMax / covered-call ETFs always pay ordinary income,
  // plus any Pr Yr Non-Qual Div action is explicitly non-qualified.
  const NONQUAL_ETFS = new Set([
    'TSLY','CONY','ULTY','AMDY','NVDY','MSFO','GOOGY','AMZY','NFLY',
    'JPMO','DISO','SQY','HOOD','PYPY','OARK','PLTY','APLY','XOMO',
    'YMAX','YMAG','LFGY','FIAT','SNOY',
  ]);
  const qualDivs = filteredTxns.filter(t =>
    t.action === 'Cash Dividend' && !NONQUAL_ETFS.has((t.symbol || '').toUpperCase())
  ).reduce((s, t) => s + (t.amount || 0), 0);
  const nonQualDivs = filteredTxns.filter(t =>
    (t.action === 'Pr Yr Non-Qual Div') ||
    (t.action === 'Cash Dividend' && NONQUAL_ETFS.has((t.symbol || '').toUpperCase())) ||
    (t.action === 'Pr Yr Cash Div')
  ).reduce((s, t) => s + (t.amount || 0), 0);

  const taxDivQual    = qualDivs    > 0 ? qualDivs    * LTCG_RATE  : 0;  // 20% qualified
  const taxDivNonQual = nonQualDivs > 0 ? nonQualDivs * STCG_RATE  : 0;  // 37% ordinary
  const taxDivTotal   = taxDivQual + taxDivNonQual;
  const taxDivBase    = (qualDivs > 0 ? qualDivs : 0) + (nonQualDivs > 0 ? nonQualDivs : 0);
  const effectiveDivRate = taxDivBase > 0 ? taxDivTotal / taxDivBase : 0;

  return {
    realized, fees, premiumCollected, assigned, winRate, avgWin, avgLoss,
    openPositions: filteredOpenPositions, closedTrades: filteredTrades, optionClosed, washFlags,
    // Extended
    optionPnl, stockPnl, dividendTotal, interestTotal, dividendCount,
    expiredTrades, btcTrades, assignedTrades, expiredPnl, btcPnl,
    assignedPuts, assignedCalls, putAssignmentExposure, putPremiumOffset, effectiveCostBasis,
    profitFactor, avgHoldDays, bestTrade, worstTrade, premiumAtRisk,
    grossWins, grossLosses,
    taxOptions, taxOptionsBase, effectiveOptRate, sec1256Pnl, equityOptPnl,
    taxStock, STCG_RATE, SEC1256_RATE,
    taxDivTotal, taxDivBase, taxDivQual, taxDivNonQual, qualDivs, nonQualDivs, effectiveDivRate, LTCG_RATE,
  };
}

function updateRangeStats(filteredTrades) {
  const card = document.getElementById('perfRangeStatsCard');
  if (!performanceDateStart && !performanceDateEnd) {
    card.style.display = 'none';
    return;
  }

  if (filteredTrades.length === 0) {
    card.style.display = 'none';
    return;
  }

  // Group trades by day and calculate daily P&L
  const dailyPnl = new Map();
  for (const t of filteredTrades) {
    const d = t.closeDate || '';
    if (!dailyPnl.has(d)) dailyPnl.set(d, []);
    dailyPnl.get(d).push(t.netPnl || 0);
  }

  // Calculate daily stats
  const dailyTotals = [...dailyPnl.entries()].map(([d, pnls]) => ({
    date: d,
    pnl: pnls.reduce((s, p) => s + p, 0),
    count: pnls.length,
  })).sort((a, b) => a.date.localeCompare(b.date));

  const avgDaily = dailyTotals.length > 0 ? dailyTotals.reduce((s, d) => s + d.pnl, 0) / dailyTotals.length : 0;
  const bestDay = dailyTotals.length > 0 ? Math.max(...dailyTotals.map(d => d.pnl)) : 0;
  const worstDay = dailyTotals.length > 0 ? Math.min(...dailyTotals.map(d => d.pnl)) : 0;
  const winDays = dailyTotals.filter(d => d.pnl > 0).length;
  const winRate = dailyTotals.length > 0 ? (winDays / dailyTotals.length) * 100 : 0;
  const totalPnl = filteredTrades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const avgPerTrade = filteredTrades.length > 0 ? totalPnl / filteredTrades.length : 0;
  const totalFees = filteredTrades.reduce((s, t) => s + (t.fees || 0), 0);

  // Update UI
  document.getElementById('rs-avg-daily').textContent = fmt$(avgDaily);
  document.getElementById('rs-avg-daily').className = `kpi-value pos ${pnlClass(avgDaily)}`;
  document.getElementById('rs-avg-daily-sub').textContent = `${dailyTotals.length} trading days`;

  document.getElementById('rs-best-day').textContent = fmt$(bestDay);
  document.getElementById('rs-best-day').className = `kpi-value pos ${pnlClass(bestDay)}`;
  document.getElementById('rs-best-day-sub').textContent = bestDay > 0 ? 'Highest daily P&L' : '—';

  document.getElementById('rs-worst-day').textContent = fmt$(worstDay);
  document.getElementById('rs-worst-day').className = `kpi-value pos ${pnlClass(worstDay)}`;
  document.getElementById('rs-worst-day-sub').textContent = worstDay < 0 ? 'Lowest daily P&L' : '—';

  document.getElementById('rs-win-rate').textContent = winRate.toFixed(1) + '%';
  document.getElementById('rs-win-rate').className = `kpi-value ${winRate >= 50 ? 'pos g' : 'pos r'}`;
  document.getElementById('rs-win-rate-sub').textContent = `${winDays}/${dailyTotals.length} days profitable`;

  document.getElementById('rs-avg-trade').textContent = fmt$(avgPerTrade);
  document.getElementById('rs-avg-trade').className = `kpi-value pos ${pnlClass(avgPerTrade)}`;
  document.getElementById('rs-avg-trade-sub').textContent = `${filteredTrades.length} trades`;

  document.getElementById('rs-total-fees').textContent = '-' + fmt$(totalFees);
  document.getElementById('rs-total-fees-sub').textContent = totalFees > 0 ? 'Fees in range' : '—';

  card.style.display = '';
}
