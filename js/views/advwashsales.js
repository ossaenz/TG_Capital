// ════════════════════════════════════════════════════════
// ADVANCED WASH SALES — lot-level analytics (CPA workflow)
// Uses db.transactions from the main app directly.
// ════════════════════════════════════════════════════════

// Sorted transaction order for lot-matching (opens before closes on same date)
const ADV_ACTION_ORDER = {
  'Sell to Open': 0, 'Buy to Open': 0, 'Buy': 0,
  'Buy to Close': 1, 'Sell to Close': 1, 'Expired': 1, 'Assigned': 1, 'Sell': 1,
};

// HTML-escape helper (not in main app)
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
}

// ── Date helpers ───────────────────────────────────────
function dateDiffDays(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

function shiftDateISO(isoDate, days) {
  if (!isoDate) return null;
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return [d.getUTCFullYear(), String(d.getUTCMonth()+1).padStart(2,'0'), String(d.getUTCDate()).padStart(2,'0')].join('-');
}

function diffDaysSigned(a, b) {
  // Returns (date a) - (date b) in days
  return Math.round((new Date(a+'T00:00:00Z') - new Date(b+'T00:00:00Z')) / 86400000);
}

// ── Risk / confidence helpers ──────────────────────────
function riskForDays(absDays) {
  if (absDays <= 7)  return 'HIGH';
  if (absDays <= 14) return 'MEDIUM';
  return 'LOW';
}

function confidenceForMatch(lossEvent, acq, strictMode) {
  if (lossEvent.symbol === acq.symbol) return 'HIGH';
  if (!strictMode && lossEvent.instrument === 'option' && acq.instrument === 'option' && lossEvent.optionType === acq.optionType) return 'MEDIUM';
  return 'LOW';
}

// ── Lot-level loss event builder ───────────────────────
function buildLossEvents(txns) {
  const openOptionLots = {};
  const openStockLots  = {};
  const losses = [];

  for (const t of txns) {
    const isOption = t.instrument === 'option';

    if (isOption && (t.action === 'Sell to Open' || t.action === 'Buy to Open')) {
      if (!openOptionLots[t.symbol]) openOptionLots[t.symbol] = [];
      openOptionLots[t.symbol].push({ date: t.date, qty: Math.abs(t.quantity || 0), openAmount: t.amount || 0 });
      continue;
    }

    if (isOption && ['Buy to Close','Sell to Close','Expired','Assigned'].includes(t.action)) {
      const lots = openOptionLots[t.symbol] || [];
      let remaining = Math.abs(t.quantity || 0) || 1;
      let matchedQty = 0, openCredit = 0, openDateFirst = null;

      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const mQty = Math.min(remaining, lot.qty);
        openCredit += (lot.qty > 0 ? lot.openAmount / lot.qty : 0) * mQty;
        matchedQty += mQty;
        if (!openDateFirst) openDateFirst = lot.date;
        lot.qty -= mQty;
        remaining -= mQty;
        if (lot.qty <= 0) lots.shift();
      }

      if (matchedQty > 0) {
        const closeAmount = (t.action === 'Expired' || t.action === 'Assigned') ? 0 : (t.amount || 0);
        const pnl = openCredit + closeAmount;
        if (pnl < -0.01) {
          const lossAmount = Math.abs(pnl);
          losses.push({
            lossId: `${t.id}::${openDateFirst || ''}`,
            closeTxnId: t.id,
            lossDate: t.date,
            symbol: t.symbol,
            underlying: t.underlying,
            instrument: 'option',
            optionType: t.optionType,
            qty: matchedQty,
            realizedLoss: lossAmount,
            lossPerUnit: matchedQty > 0 ? lossAmount / matchedQty : 0,
          });
        }
      }
      continue;
    }

    if (!isOption && t.action === 'Buy') {
      if (!openStockLots[t.symbol]) openStockLots[t.symbol] = [];
      openStockLots[t.symbol].push({ date: t.date, qty: Math.abs(t.quantity || 0), costBasis: Math.abs(t.amount || 0) });
      continue;
    }

    if (!isOption && t.action === 'Sell') {
      const lots = openStockLots[t.symbol] || [];
      let remaining = Math.abs(t.quantity || 0);
      let matchedQty = 0, totalCost = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const mQty = Math.min(remaining, lot.qty);
        totalCost += (lot.qty > 0 ? lot.costBasis / lot.qty : 0) * mQty;
        matchedQty += mQty;
        lot.qty -= mQty;
        remaining -= mQty;
        if (lot.qty <= 0) lots.shift();
      }

      if (matchedQty > 0) {
        const sellQty = Math.abs(t.quantity || 0) || matchedQty;
        const proceeds = Math.abs(t.amount || 0) * Math.min(1, matchedQty / sellQty);
        const pnl = proceeds - totalCost;
        if (pnl < -0.01) {
          const lossAmount = Math.abs(pnl);
          losses.push({
            lossId: `${t.id}`,
            closeTxnId: t.id,
            lossDate: t.date,
            symbol: t.symbol,
            underlying: t.symbol,
            instrument: 'stock',
            optionType: null,
            qty: matchedQty,
            realizedLoss: lossAmount,
            lossPerUnit: matchedQty > 0 ? lossAmount / matchedQty : 0,
          });
        }
      }
    }
  }
  return losses;
}

function buildAcquisitions(txns) {
  return txns
    .filter(t => t.date && ['Buy','Buy to Open','Sell to Open'].includes(t.action) && Math.abs(t.quantity || 0) > 0)
    .map(t => ({
      id: t.id,
      date: t.date,
      action: t.action,
      symbol: t.symbol,
      underlying: t.underlying,
      instrument: t.instrument,
      optionType: t.optionType,
      qty: Math.abs(t.quantity || 0),
      remainingQty: Math.abs(t.quantity || 0),
    }));
}

function isSubstantiallyIdentical(lossEvent, acq, strictMode) {
  if (lossEvent.underlying !== acq.underlying) return false;
  if (strictMode) {
    if (lossEvent.instrument === 'option') return acq.instrument === 'option' && acq.symbol === lossEvent.symbol;
    return acq.instrument !== 'option' && acq.symbol === lossEvent.symbol;
  }
  if (lossEvent.instrument === 'option') return acq.instrument === 'option' && acq.optionType === lossEvent.optionType;
  return acq.instrument !== 'option' && acq.symbol === lossEvent.symbol;
}

// ── Core engine ────────────────────────────────────────
function computeWashAnalytics(txns, settings) {
  const strictMode    = settings.mode === 'strict';
  const includeBefore = settings.windowSide === 'both';

  const lossEvents   = buildLossEvents(txns);
  const acquisitions = buildAcquisitions(txns);
  const matches      = [];
  const summaryMap   = new Map();

  for (const ev of lossEvents) {
    let remainingLossQty = ev.qty;
    let eventDisallowed  = 0;
    let eventMatchedQty  = 0;

    const candidates = acquisitions
      .filter(a => {
        if (a.id === ev.closeTxnId || a.remainingQty <= 0) return false;
        if (!isSubstantiallyIdentical(ev, a, strictMode)) return false;
        const d = diffDaysSigned(a.date, ev.lossDate);
        if (!includeBefore && d < 0) return false;
        return Math.abs(d) <= 30;
      })
      .sort((a, b) => {
        const da = Math.abs(diffDaysSigned(a.date, ev.lossDate));
        const db = Math.abs(diffDaysSigned(b.date, ev.lossDate));
        return da !== db ? da - db : a.date.localeCompare(b.date);
      });

    for (const acq of candidates) {
      if (remainingLossQty <= 0) break;
      if (acq.remainingQty <= 0) continue;
      const matchedQty  = Math.min(remainingLossQty, acq.remainingQty);
      const disallowed  = matchedQty * ev.lossPerUnit;
      const signedDays  = diffDaysSigned(acq.date, ev.lossDate);
      const absDays     = Math.abs(signedDays);
      matches.push({
        lossId: ev.lossId,
        lossDate: ev.lossDate,
        lossSymbol: ev.symbol,
        lossQty: ev.qty,
        lossPerUnit: ev.lossPerUnit,
        replacementId: acq.id,
        replacementDate: acq.date,
        replacementSymbol: acq.symbol,
        replacementAction: acq.action,
        replacementQty: acq.qty,
        matchedQty,
        disallowed,
        daysSigned: signedDays,
        daysAbs: absDays,
        risk: riskForDays(absDays),
        confidence: confidenceForMatch(ev, acq, strictMode),
      });
      eventDisallowed  += disallowed;
      eventMatchedQty  += matchedQty;
      remainingLossQty -= matchedQty;
      acq.remainingQty -= matchedQty;
    }

    summaryMap.set(ev.lossId, {
      lossId: ev.lossId,
      lossDate: ev.lossDate,
      symbol: ev.symbol,
      instrument: ev.instrument,
      lossQty: ev.qty,
      realizedLoss: ev.realizedLoss,
      matchedQty: eventMatchedQty,
      disallowed: eventDisallowed,
      deductibleNow: Math.max(0, ev.realizedLoss - eventDisallowed),
      optionType: ev.optionType,
    });
  }

  const summaries = Array.from(summaryMap.values()).sort((a, b) => b.lossDate.localeCompare(a.lossDate));

  const adjMap = new Map();
  for (const m of matches) {
    if (!adjMap.has(m.replacementId)) {
      adjMap.set(m.replacementId, {
        replacementId: m.replacementId,
        replacementDate: m.replacementDate,
        replacementSymbol: m.replacementSymbol,
        replacementAction: m.replacementAction,
        replacementQty: m.replacementQty,
        matchedQty: 0,
        basisAdj: 0,
      });
    }
    const row = adjMap.get(m.replacementId);
    row.matchedQty += m.matchedQty;
    row.basisAdj   += m.disallowed;
  }
  const replacementAdjustments = Array.from(adjMap.values())
    .map(r => ({ ...r, adjPerUnit: r.matchedQty > 0 ? r.basisAdj / r.matchedQty : 0 }))
    .sort((a, b) => b.replacementDate.localeCompare(a.replacementDate));

  return { summaries, matches, replacementAdjustments };
}

// ── Settings & filter ──────────────────────────────────
function advGetSettings() {
  return {
    taxYear:    document.getElementById('advTaxYear')?.value  || '',
    dateFrom:   document.getElementById('advDateFrom')?.value || '',
    dateTo:     document.getElementById('advDateTo')?.value   || '',
    mode:       document.getElementById('advMode')?.value     || 'strict',
    windowSide: document.getElementById('advWindow')?.value   || 'both',
    symbol:     (document.getElementById('advSymbol')?.value  || '').trim().toUpperCase(),
    risk:       document.getElementById('advRisk')?.value     || '',
  };
}

function advFilterData(all, settings) {
  const { taxYear, dateFrom, dateTo, symbol, risk } = settings;

  const filteredMatches = all.matches.filter(m => {
    if (taxYear && String(m.lossDate||'').slice(0,4) !== taxYear) return false;
    if (dateFrom && (m.lossDate||'') < dateFrom) return false;
    if (dateTo   && (m.lossDate||'') > dateTo)   return false;
    if (symbol   && !(m.lossSymbol||'').toUpperCase().includes(symbol)) return false;
    if (risk     && m.risk !== risk) return false;
    return true;
  });

  const matchedIds = new Set(filteredMatches.map(m => m.lossId));
  const filteredSummaries = all.summaries.filter(s => {
    if (taxYear && String(s.lossDate||'').slice(0,4) !== taxYear) return false;
    if (dateFrom && (s.lossDate||'') < dateFrom) return false;
    if (dateTo   && (s.lossDate||'') > dateTo)   return false;
    if (symbol   && !(s.symbol||'').toUpperCase().includes(symbol)) return false;
    if (!risk) return true;
    return matchedIds.has(s.lossId);
  });

  const replacementIds = new Set(filteredMatches.map(m => m.replacementId));
  const filteredAdjustments = all.replacementAdjustments.filter(r =>
    replacementIds.has(r.replacementId) || (!risk && !symbol));

  return { filteredMatches, filteredSummaries, filteredAdjustments };
}

// ── Year picker helpers ────────────────────────────────
function advGetAvailableTaxYears() {
  const years = new Set();
  for (const t of (db.transactions || [])) {
    const y = String(t.date||'').slice(0,4);
    if (/^\d{4}$/.test(y)) years.add(y);
  }
  return Array.from(years).sort((a,b) => b.localeCompare(a));
}

function advPopulateTaxYearSelect() {
  const sel = document.getElementById('advTaxYear');
  if (!sel) return;
  const prev  = sel.value;
  const years = advGetAvailableTaxYears();
  sel.innerHTML = '<option value="">All years</option>' +
    years.map(y => `<option value="${y}">${y}</option>`).join('');
  if (prev && years.includes(prev)) sel.value = prev;
  else if (years.length === 1) sel.value = years[0];
}

// ── Coverage notice ────────────────────────────────────
function advGetBoundaryCoverageStatus(settings) {
  const taxYear = settings.taxYear;
  const allDates = (db.transactions||[]).map(t=>t.date).filter(Boolean).sort();
  const dataMin  = allDates.length ? allDates[0] : null;
  const dataMax  = allDates.length ? allDates[allDates.length-1] : null;

  if (!taxYear) return { status:'SELECT YEAR', color:'var(--text2)', sub:'Pick a tax year to validate ±30d boundary coverage' };
  if (!dataMin) return { status:'UNKNOWN', color:'var(--text2)', sub:'No transaction dates available' };

  const reqStart = shiftDateISO(`${taxYear}-01-01`, -30);
  const reqEnd   = shiftDateISO(`${taxYear}-12-31`,  30);
  const hasPre   = dataMin <= reqStart;
  const hasPost  = dataMax >= reqEnd;

  if ( hasPre &&  hasPost) return { status:'OK',           color:'var(--green)', sub:`Boundary covered for ${taxYear} (${reqStart} → ${reqEnd})` };
  if (!hasPre && !hasPost) return { status:'MISSING BOTH', color:'var(--red)',   sub:`Need data ≤ ${reqStart} and ≥ ${reqEnd}` };
  if (!hasPre)             return { status:'MISSING PRE',  color:'var(--amber)', sub:`Need data through ${reqStart} before ${taxYear}` };
  return                          { status:'MISSING POST', color:'var(--amber)', sub:`Need data through ${reqEnd} after ${taxYear}` };
}

function advUpdateCoverageNotice() {
  const el = document.getElementById('advCoverageNotice');
  if (!el) return;
  const meta = db.meta || {};
  const fromDate = meta.fromDate || null;
  const toDate   = meta.toDate   || null;
  if (!fromDate || !toDate) { el.style.display = 'none'; return; }
  const span = dateDiffDays(fromDate, toDate);
  if (span !== null && span < 61) {
    el.style.display = 'block';
    el.textContent = `Data range is ${span+1} days (${fromDate} → ${toDate}). Analysis may miss matches outside this window. Use 61+ days around any loss date for reliable results.`;
  } else {
    el.style.display = 'none';
  }
}

// ── Renderers ──────────────────────────────────────────
function advRenderKPIs(filtered, settings) {
  const totalLoss       = filtered.filteredSummaries.reduce((s,r) => s+r.realizedLoss, 0);
  const totalDisallowed = filtered.filteredSummaries.reduce((s,r) => s+r.disallowed, 0);
  const deductibleNow   = filtered.filteredSummaries.reduce((s,r) => s+r.deductibleNow, 0);
  const matchedEvents   = filtered.filteredSummaries.filter(r=>r.matchedQty>0).length;
  const totalEvents     = filtered.filteredSummaries.length;
  const highRisk        = filtered.filteredMatches.filter(m=>m.risk==='HIGH').length;
  const avgDays = filtered.filteredMatches.length
    ? filtered.filteredMatches.reduce((s,m)=>s+m.daysAbs,0) / filtered.filteredMatches.length
    : 0;
  const boundary = advGetBoundaryCoverageStatus(settings);

  const cards = [
    { label:'Loss Events',            value:String(totalEvents),         sub:`${matchedEvents} with replacement matches`, color:'var(--text0)' },
    { label:'Total Realized Loss',    value:fmt$(totalLoss),             sub:'From matched closed lots',                  color:'var(--red)' },
    { label:'Disallowed Loss',        value:fmt$(totalDisallowed),       sub:'Allocated to replacement basis',            color:'var(--amber)' },
    { label:'Deductible Now',         value:fmt$(deductibleNow),         sub:'Current-year deductible portion',           color:'var(--green)' },
    { label:'High-Risk Matches',      value:String(highRisk),            sub:`${filtered.filteredMatches.length} total`,  color:highRisk>0?'var(--red)':'var(--text1)' },
    { label:'Avg Match Distance',     value:filtered.filteredMatches.length ? `${avgDays.toFixed(1)}d` : '0d', sub:'Absolute days from loss date', color:'var(--teal)' },
    { label:'Boundary Coverage ±30d', value:boundary.status,             sub:boundary.sub,                                color:boundary.color },
  ];

  document.getElementById('advKpiGrid').innerHTML = cards.map(c => `
    <div class="rpt-kpi">
      <div class="rpt-kpi-label">${esc(c.label)}</div>
      <div class="rpt-kpi-val" style="font-size:17px;color:${c.color}">${esc(c.value)}</div>
      <div class="rpt-kpi-sub">${esc(c.sub)}</div>
    </div>`).join('');
}

function advRenderBars(filtered) {
  const bySymbol = new Map();
  for (const row of filtered.filteredSummaries) {
    const k = row.symbol || 'UNKNOWN';
    bySymbol.set(k, (bySymbol.get(k)||0) + (row.disallowed||0));
  }
  const data = Array.from(bySymbol.entries())
    .map(([sym,val]) => ({ sym, val }))
    .filter(x => x.val > 0)
    .sort((a,b) => b.val - a.val)
    .slice(0, 10);

  const el = document.getElementById('advBars');
  if (!data.length) {
    el.innerHTML = '<div style="color:var(--text2);font-size:13px;padding:12px 0">No disallowed-loss allocations for current filters.</div>';
    return;
  }
  const maxVal = Math.max(...data.map(x=>x.val), 1);
  el.innerHTML = data.map(x => {
    const w = Math.max(3, Math.round(x.val/maxVal*100));
    return `<div class="adv-bar-row">
      <div class="adv-bar-name">${esc(x.sym)}</div>
      <div class="adv-bar-track"><div class="adv-bar-fill" style="width:${w}%"></div></div>
      <div class="adv-bar-val">${esc(fmt$(x.val))}</div>
    </div>`;
  }).join('');
}

function advRenderLossSummary(filtered) {
  const tbody = document.getElementById('advLossSummaryBody');
  if (!filtered.filteredSummaries.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:20px">No loss events for current filters.</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.filteredSummaries.map(r => `
    <tr>
      <td>${esc(r.lossDate)}</td>
      <td style="font-family:var(--mono);font-weight:700">${esc(r.symbol)}</td>
      <td>${esc(r.instrument==='option' ? (r.optionType?'OPTION '+r.optionType.toUpperCase():'OPTION') : 'STOCK')}</td>
      <td class="r">${esc(String(r.lossQty))}</td>
      <td class="r" style="color:var(--red)">${esc(fmt$(r.realizedLoss))}</td>
      <td class="r">${esc(String(r.matchedQty))}</td>
      <td class="r" style="color:var(--amber)">${esc(fmt$(r.disallowed))}</td>
      <td class="r" style="color:var(--green)">${esc(fmt$(r.deductibleNow))}</td>
    </tr>`).join('');
}

function advRenderAdjustments(filtered) {
  const tbody = document.getElementById('advAdjBody');
  if (!filtered.filteredAdjustments.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:20px">No replacement basis adjustments for current filters.</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.filteredAdjustments.map(r => `
    <tr>
      <td>${esc(r.replacementDate)}</td>
      <td style="font-family:var(--mono)">${esc(r.replacementSymbol)}</td>
      <td>${esc(r.replacementAction)}</td>
      <td class="r">${esc(String(r.replacementQty))}</td>
      <td class="r">${esc(String(r.matchedQty))}</td>
      <td class="r" style="color:var(--amber)">${esc(fmt$(r.basisAdj))}</td>
      <td class="r">${esc(fmt$(r.adjPerUnit))}</td>
    </tr>`).join('');
}

function advRenderMatches(filtered) {
  const tbody = document.getElementById('advMatchBody');
  if (!filtered.filteredMatches.length) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text2);padding:20px">No wash matches for current filters.</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.filteredMatches.map(r => {
    const rClass = r.risk==='HIGH' ? 'badge-risk-high' : r.risk==='MEDIUM' ? 'badge-risk-medium' : 'badge-risk-low';
    return `<tr>
      <td>${esc(r.lossDate)}</td>
      <td style="font-family:var(--mono);font-weight:700">${esc(r.lossSymbol)}</td>
      <td class="r">${esc(String(r.lossQty))}</td>
      <td class="r">${esc(fmt$(r.lossPerUnit))}</td>
      <td>${esc(r.replacementDate)}</td>
      <td style="font-family:var(--mono)">${esc(r.replacementSymbol)}</td>
      <td>${esc(r.replacementAction)}</td>
      <td class="r">${esc(String(r.daysSigned))}</td>
      <td class="r">${esc(String(r.matchedQty))}</td>
      <td class="r" style="color:var(--amber)">${esc(fmt$(r.disallowed))}</td>
      <td class="c"><span class="badge ${rClass}">${esc(r.risk)}</span></td>
      <td class="c" style="color:var(--text2)">${esc(r.confidence)}</td>
    </tr>`;
  }).join('');
}

// ── Main render entry point ────────────────────────────
function advRenderAll() {
  advPopulateTaxYearSelect();
  advUpdateCoverageNotice();
  const settings = advGetSettings();

  // Sort ascending (opens before closes) — required for lot-matching
  const txns = [...(db.transactions||[])].sort((a, b) => {
    const d = (a.date||'').localeCompare(b.date||'');
    if (d !== 0) return d;
    return (ADV_ACTION_ORDER[a.action]??9) - (ADV_ACTION_ORDER[b.action]??9);
  });

  window._advAnalytics = computeWashAnalytics(txns, settings);
  const filtered = advFilterData(window._advAnalytics, settings);

  advRenderKPIs(filtered, settings);
  advRenderBars(filtered);
  advRenderLossSummary(filtered);
  advRenderAdjustments(filtered);
  advRenderMatches(filtered);
}

// ── CSV Export ─────────────────────────────────────────
function advDownloadCSV(name, rows) {
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function advExportMatchLedgerCSV() {
  if (!window._advAnalytics) { alert('Run the analysis first.'); return; }
  const filtered = advFilterData(window._advAnalytics, advGetSettings());
  const rows = [
    ['Loss Date','Loss Symbol','Loss Qty','Loss Per Unit','Replacement Date','Replacement Symbol','Replacement Action','Days Signed','Matched Qty','Disallowed Loss','Risk','Confidence'].map(_wsCell).join(','),
    ...filtered.filteredMatches.map(r =>
      [r.lossDate,r.lossSymbol,r.lossQty,r.lossPerUnit.toFixed(6),
       r.replacementDate,r.replacementSymbol,r.replacementAction,r.daysSigned,
       r.matchedQty,r.disallowed.toFixed(2),r.risk,r.confidence].map(_wsCell).join(',')),
  ];
  advDownloadCSV('TGCapital_AdvancedWash_MatchLedger.csv', rows);
}

function advExportForm8949CSV() {
  if (!window._advAnalytics) { alert('Run the analysis first.'); return; }
  const filtered = advFilterData(window._advAnalytics, advGetSettings());
  const meta = db.meta || {};
  const rows = [
    ['TGCapital — Form 8949 Estimated Export'].map(_wsCell).join(','),
    ['Generated At', new Date().toISOString()].map(_wsCell).join(','),
    ['Source Range', `${meta.fromDate||'?'} to ${meta.toDate||'?'}`].map(_wsCell).join(','),
    [],
    ['Description','Date Acquired','Date Sold','Proceeds','Cost or Other Basis','Adjustment Code','Adjustment Amount','Gain or (Loss)','Symbol','Instrument','Loss Qty','Matched Qty','Confidence'].map(_wsCell).join(','),
    ...filtered.filteredSummaries.map(r =>
      [`Estimated wash-sale disposition: ${r.symbol}`,
       '', r.lossDate, '', '',
       r.disallowed>0?'W':'',
       r.disallowed>0?r.disallowed.toFixed(2):'0.00',
       (-r.deductibleNow).toFixed(2),
       r.symbol,
       r.instrument==='option'?(r.optionType?`option-${r.optionType}`:'option'):'stock',
       r.lossQty, r.matchedQty,
       r.matchedQty>0?'review':'none'].map(_wsCell).join(',')),
  ];
  advDownloadCSV('TGCapital_AdvancedWash_Form8949_Estimate.csv', rows);
}
