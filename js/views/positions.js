let closedFilter = 'all';
let posFilter = 'all';
let closedDateStart = null;
let closedDateEnd   = null;
let tradeDateStart  = null;
let tradeDateEnd    = null;
let openDateStart   = null;
let openDateEnd     = null;
let auditDateStart  = null;
let auditDateEnd    = null;
let auditSortBy     = null;
let auditSortAsc    = true;

function applyOpenFilter() {
  const yr = document.getElementById('openYearSelect').value;
  const s  = document.getElementById('openDateStart').value;
  const e  = document.getElementById('openDateEnd').value;
  if (yr) { openDateStart = `${yr}-01-01`; openDateEnd = `${yr}-12-31`; }
  else    { openDateStart = s || null; openDateEnd = e || null; }
  updateOpenFilterLabel();
  renderPositions();
}

function resetOpenFilter() {
  openDateStart = null; openDateEnd = null;
  document.getElementById('openYearSelect').value = '';
  document.getElementById('openDateStart').value  = '';
  document.getElementById('openDateEnd').value    = '';
  updateOpenFilterLabel();
  renderPositions();
}

function updateOpenFilterLabel() {
  const el = document.getElementById('openFilterLabel');
  if (!el) return;
  el.textContent = (openDateStart || openDateEnd)
    ? `Opened ${openDateStart || '–'} to ${openDateEnd || '–'}`
    : '';
}

function applyClosedFilter() {
  const yr = document.getElementById('closedYearSelect').value;
  const s  = document.getElementById('closedDateStart').value;
  const e  = document.getElementById('closedDateEnd').value;
  if (yr) { closedDateStart = `${yr}-01-01`; closedDateEnd = `${yr}-12-31`; }
  else    { closedDateStart = s || null; closedDateEnd = e || null; }
  updateClosedFilterLabel();
  renderClosedPositions();
}

function resetClosedFilter() {
  closedDateStart = null; closedDateEnd = null;
  document.getElementById('closedYearSelect').value = '';
  document.getElementById('closedDateStart').value  = '';
  document.getElementById('closedDateEnd').value    = '';
  updateClosedFilterLabel();
  renderClosedPositions();
}

function updateClosedFilterLabel() {
  const el = document.getElementById('closedFilterLabel');
  if (!el) return;
  el.textContent = (closedDateStart || closedDateEnd)
    ? `${closedDateStart || '–'} to ${closedDateEnd || '–'}`
    : '';
}


function filterClosed(f, btn) {
  closedFilter = f;
  document.querySelectorAll('#view-closed .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderClosedPositions();
}

function renderClosedPositions() {
  // Only show option round-trips (trades that have a strike price)
  const { closedTrades: allClosed } = buildPositions();
  let closedTrades = allClosed.filter(t => t.instrument === 'option');

  // Apply date filter
  if (closedDateStart || closedDateEnd) {
    closedTrades = closedTrades.filter(t => {
      const d = t.closeDate || '';
      if (closedDateStart && d < closedDateStart) return false;
      if (closedDateEnd   && d > closedDateEnd)   return false;
      return true;
    });
  }

  const search = (document.getElementById('closedSearch').value || '').toLowerCase();
  const isFiltered = !!(closedDateStart || closedDateEnd);

  // KPIs — reflect filtered range
  const gross = closedTrades.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const fees  = closedTrades.reduce((s, t) => s + (t.fees || 0), 0);
  const net   = closedTrades.reduce((s, t) => s + (t.netPnl || 0), 0);
  document.getElementById('ck-count').textContent    = closedTrades.length;
  document.querySelector('#ck-count + .kpi-sub').textContent = isFiltered ? 'In date range' : 'All closed trades';
  document.getElementById('ck-gross').textContent    = fmt$(gross);
  document.getElementById('ck-gross').className      = 'kpi-value pos ' + pnlClass(gross);
  document.getElementById('ck-fees').textContent     = '-' + fmt$(fees);
  document.getElementById('ck-net').textContent      = fmt$(net);
  document.getElementById('ck-net').className        = 'kpi-value pos ' + pnlClass(net);
  document.getElementById('ck-expired').textContent   = closedTrades.filter(t => t.via === 'expired').length;
  document.getElementById('ck-assigned').textContent  = closedTrades.filter(t => t.via === 'assigned').length;
  document.getElementById('ck-exercised').textContent = closedTrades.filter(t => t.via === 'exercised').length;

  // Filter + sort newest first
  let rows = [...closedTrades].sort((a, b) => (b.closeDate || '').localeCompare(a.closeDate || ''));
  if (search) rows = rows.filter(t => (t.symbol + ' ' + (t.underlying||'')).toLowerCase().includes(search));
  if (closedFilter === 'btc')           rows = rows.filter(t => t.via === 'closed');
  else if (closedFilter === 'expired')  rows = rows.filter(t => t.via === 'expired');
  else if (closedFilter === 'assigned')  rows = rows.filter(t => t.via === 'assigned');
  else if (closedFilter === 'exercised') rows = rows.filter(t => t.via === 'exercised');
  else if (closedFilter === 'sold')     rows = rows.filter(t => t.via === 'sold');
  else if (closedFilter === 'wins')     rows = rows.filter(t => (t.netPnl || 0) > 0);
  else if (closedFilter === 'losses')   rows = rows.filter(t => (t.netPnl || 0) < 0);

  const tbody = document.querySelector('#closedTable tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No trades match filter.</td></tr>';
    document.getElementById('closedTableFooter').innerHTML = '';
    return;
  }

  // Each position = 3 rows: OPEN leg, CLOSE leg, P&L summary
  const html = [];
  for (const t of rows) {
    const isOpt   = t.instrument === 'option';
    const instBdg = instBadge(t.instrument, t.optionType);
    const netCls  = pnlClass(t.netPnl);
    const qty     = t.qty || 1;

    // ── build the contract/instrument label ──
    let contractLabel;
    if (isOpt) {
      const putCall = t.optionType === 'put' ? 'PUT' : 'CALL';
      const strikeStr = t.strike != null ? '$' + t.strike.toFixed(2) : '';
      const expiryStr = t.expiry || '';
      contractLabel = `<span style="font-family:var(--mono);font-weight:700;font-size:13px">${t.underlying}</span>
        <span style="color:var(--text2);font-size:11px;margin-left:6px">${putCall} ${strikeStr} exp ${expiryStr}</span>`;
    } else {
      contractLabel = `<span style="font-family:var(--mono);font-weight:700;font-size:13px">${t.symbol}</span>`;
    }

    // ── OPEN LEG row ──
    const openAction   = t.via === 'sold' ? 'BUY' : 'SELL TO OPEN';
    const openPriceStr = isOpt
      ? (t.openPrice ? '$' + t.openPrice.toFixed(2) + '/contract' : '—')
      : (t.openPrice ? '$' + t.openPrice.toFixed(2) + '/share' : '—');
    const openCreditStr = t.openCredit >= 0
      ? `<span class="pos g">+${fmt$(t.openCredit)}</span>`
      : `<span class="pos r">${fmt$(t.openCredit)}</span>`;
    const openFeesStr = t.openFees > 0 ? `<span style="color:var(--text2)">-${fmt$(t.openFees)}</span>` : '<span style="color:var(--text2)">—</span>';

    html.push(`<tr class="leg-open" style="background:var(--bg2)">
      <td rowspan="3" style="border-right:2px solid var(--border-hi);vertical-align:top;padding-top:12px">
        ${instBdg}<br>
        <span style="font-size:10px;font-family:var(--mono);color:var(--text2);margin-top:4px;display:block">${qty}x contract${qty>1?'s':''}</span>
      </td>
      <td style="padding-top:10px">
        <span style="font-size:10px;font-family:var(--mono);color:var(--text2);text-transform:uppercase;letter-spacing:.08em">${openAction}</span><br>
        ${contractLabel}
      </td>
      <td style="color:var(--text2);font-size:12px;padding-top:14px">${t.openDate || '—'}</td>
      <td class="r" style="padding-top:14px"><span style="color:var(--text1)">${openPriceStr}</span></td>
      <td class="r" style="padding-top:14px">${openCreditStr}</td>
      <td class="r" style="padding-top:14px">${openFeesStr}</td>
      <td></td><td></td><td></td>
    </tr>`);

    // ── CLOSE LEG row ──
    let closeAction2, closePriceStr, closeAmtStr, viaBadge;
    if (t.via === 'expired') {
      closeAction2  = 'EXPIRED WORTHLESS';
      closePriceStr = '<span style="color:var(--text2)">$0.00</span>';
      closeAmtStr   = '<span style="color:var(--text2)">$0.00</span>';
      viaBadge      = '<span class="badge badge-expired">EXPIRED WORTHLESS</span>';
    } else if (t.via === 'assigned') {
      closeAction2  = 'ASSIGNED';
      closePriceStr = t.strike != null ? `<span style="color:var(--amber)">$${t.strike.toFixed(2)} strike</span>` : '—';
      closeAmtStr   = '<span style="color:var(--amber)">Stock received</span>';
      viaBadge      = '<span class="badge badge-assigned">ASSIGNED</span>';
    } else if (t.via === 'exercised') {
      closeAction2  = 'CALLED AWAY';
      closePriceStr = t.strike != null ? `<span style="color:var(--green)">$${t.strike.toFixed(2)} strike</span>` : '—';
      closeAmtStr   = '<span style="color:var(--green)">Shares called away</span>';
      viaBadge      = '<span class="badge badge-closed" style="background:#1f2c1f;color:var(--green);border-color:#2d4a2d">CALLED AWAY</span>';
    } else if (t.via === 'sold') {
      closeAction2  = 'SELL';
      closePriceStr = t.closePrice ? '$' + t.closePrice.toFixed(2) + '/share' : '—';
      closeAmtStr   = `<span class="pos g">+${fmt$(t.closeCost)}</span>`;
      viaBadge      = '<span class="badge badge-closed">SOLD</span>';
    } else {
      closeAction2  = t.closeAction || 'BUY TO CLOSE';
      closePriceStr = t.closePrice ? `<span style="color:var(--red)">$${t.closePrice.toFixed(2)}/contract</span>` : '—';
      closeAmtStr   = t.closeCost  ? `<span class="pos r">${fmt$(t.closeCost)}</span>` : '—';
      viaBadge      = '<span class="badge badge-closed">BUY TO CLOSE</span>';
    }
    const closeFeesStr = t.closeFees > 0 ? `<span style="color:var(--text2)">-${fmt$(t.closeFees)}</span>` : '<span style="color:var(--text2)">—</span>';

    html.push(`<tr class="leg-close">
      <td>
        <span style="font-size:10px;font-family:var(--mono);color:var(--text2);text-transform:uppercase;letter-spacing:.08em">${closeAction2}</span><br>
        ${viaBadge}
      </td>
      <td style="color:var(--text2);font-size:12px">${t.closeDate || '—'}</td>
      <td class="r">${closePriceStr}</td>
      <td class="r">${closeAmtStr}</td>
      <td class="r">${closeFeesStr}</td>
      <td></td><td></td><td></td>
    </tr>`);

    // ── P&L SUMMARY row ──
    const grossStr  = `<span class="pos ${pnlClass(t.grossPnl)}">${fmt$(t.grossPnl)}</span>`;
    const totalFStr = `<span style="color:var(--red)">-${fmt$(t.fees)}</span>`;
    const netStr    = `<span class="pos ${netCls}" style="font-size:14px;font-weight:700">${fmt$(t.netPnl)}</span>`;

    // P&L math breakdown inline: e.g.  +$195.34 − $6.66 − $1.32 = $187.36
    let mathLine = '';
    if (t.via === 'expired') {
      mathLine = `<span style="color:var(--text2);font-size:11px">Premium ${fmt$(t.openCredit)} &minus; fees ${fmt$(t.fees)} = </span>`;
    } else if (t.via === 'assigned') {
      mathLine = `<span style="color:var(--text2);font-size:11px">Premium ${fmt$(t.openCredit)} &minus; fees ${fmt$(t.fees)} = </span>`;
    } else if (t.via === 'exercised') {
      mathLine = `<span style="color:var(--text2);font-size:11px">Premium ${fmt$(t.openCredit)} &minus; fees ${fmt$(t.fees)} = </span>`;
    } else if (t.via === 'sold') {
      mathLine = `<span style="color:var(--text2);font-size:11px">Proceeds ${fmt$(t.closeCost)} &minus; cost ${fmt$(Math.abs(t.openCredit))} &minus; fees ${fmt$(t.fees)} = </span>`;
    } else {
      mathLine = `<span style="color:var(--text2);font-size:11px">Premium ${fmt$(t.openCredit)} &minus; close cost ${fmt$(Math.abs(t.closeCost))} &minus; fees ${fmt$(t.fees)} = </span>`;
    }

    html.push(`<tr class="leg-summary" style="border-bottom:2px solid var(--border-hi)">
      <td colspan="4" style="padding-top:4px;padding-bottom:10px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${mathLine}${netStr}
        </div>
      </td>
      <td class="r" style="padding-bottom:10px">${totalFStr}</td>
      <td class="r" style="padding-bottom:10px">${grossStr}</td>
      <td class="r" style="padding-bottom:10px">${netStr}</td>
      <td></td>
    </tr>`);
  }

  tbody.innerHTML = html.join('');

  // Footer totals
  const fGross = rows.reduce((s, r) => s + (r.grossPnl || 0), 0);
  const fFees  = rows.reduce((s, r) => s + (r.fees  || 0), 0);
  const fNet   = rows.reduce((s, r) => s + (r.netPnl || 0), 0);
  document.getElementById('closedTableFooter').innerHTML =
    `<span style="color:var(--text2)">${rows.length} positions shown</span>` +
    `<span style="margin-left:auto;color:var(--text2)">Gross: <span class="pos ${pnlClass(fGross)}">${fmt$(fGross)}</span></span>` +
    `<span style="color:var(--text2)">Fees: <span style="color:var(--red)">-${fmt$(fFees)}</span></span>` +
    `<span style="color:var(--text2)">Net P&amp;L: <span class="pos ${pnlClass(fNet)}" style="font-weight:700">${fmt$(fNet)}</span></span>`;
}

function filterPositions(f, btn) {
  posFilter = f;
  document.querySelectorAll('#view-positions .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPositions();
}

function renderPositions() {
  const { openPositions } = buildPositions();
  let pos = openPositions;

  if (openDateStart || openDateEnd) {
    pos = pos.filter(p => {
      const d = p.openDate || '';
      if (openDateStart && d < openDateStart) return false;
      if (openDateEnd   && d > openDateEnd)   return false;
      return true;
    });
  }

  if (posFilter === 'option') pos = pos.filter(p => p.instrument === 'option');
  else if (posFilter === 'stock') pos = pos.filter(p => p.instrument !== 'option');
  else if (posFilter === 'put') pos = pos.filter(p => p.optionType === 'put');
  else if (posFilter === 'call') pos = pos.filter(p => p.optionType === 'call');

  const tbody = document.querySelector('#positionsTable tbody');
  if (pos.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No open positions.</td></tr>';
    return;
  }
  tbody.innerHTML = pos.map(p => {
    return `<tr>
      <td><span style="font-family:var(--mono);font-weight:700;">${p.symbol}</span></td>
      <td>${instBadge(p.instrument, p.optionType)}</td>
      <td>${dirBadge(p.direction)}</td>
      <td class="r">${p.qty}</td>
      <td class="r">${p.avgCost !== null ? fmt$(p.avgCost) : '—'}</td>
      <td class="r">${p.strike ? '$' + p.strike : '—'}</td>
      <td>${p.expiry || '—'}</td>
      <td>${p.openDate || '—'}</td>
      <td>${statusBadge('open')}</td>
      <td class="r"><span class="pos g">${p.premiumRcvd ? fmt$(p.premiumRcvd) : '—'}</span></td>
      <td class="r">—</td>
    </tr>`;
  }).join('');
}

