function applyTradeFilter() {
  const yr = document.getElementById('tradeYearSelect').value;
  const s  = document.getElementById('tradeDateStart').value;
  const e  = document.getElementById('tradeDateEnd').value;
  if (yr) { tradeDateStart = `${yr}-01-01`; tradeDateEnd = `${yr}-12-31`; }
  else    { tradeDateStart = s || null; tradeDateEnd = e || null; }
  updateTradeFilterLabel();
  renderTradeTable();
}

function resetTradeFilter() {
  tradeDateStart = null; tradeDateEnd = null;
  document.getElementById('tradeYearSelect').value = '';
  document.getElementById('tradeDateStart').value  = '';
  document.getElementById('tradeDateEnd').value    = '';
  updateTradeFilterLabel();
  renderTradeTable();
}

function updateTradeFilterLabel() {
  const el = document.getElementById('tradeFilterLabel');
  if (!el) return;
  el.textContent = (tradeDateStart || tradeDateEnd)
    ? `${tradeDateStart || '–'} to ${tradeDateEnd || '–'}`
    : '';
}


function renderTradeTable() {
  const search = (document.getElementById('tradeSearch').value || '').toLowerCase();
  const actionFilter = document.getElementById('tradeActionFilter').value;
  const washFlags = detectWashSales();
  const washIds = new Set(washFlags.flatMap(f => [f.lossTxn.id, f.repTxn.id]));

  let txns = db.transactions;
  if (tradeDateStart || tradeDateEnd) {
    txns = txns.filter(t => {
      const d = t.date || t.rawDate || '';
      if (tradeDateStart && d < tradeDateStart) return false;
      if (tradeDateEnd   && d > tradeDateEnd)   return false;
      return true;
    });
  }
  if (search) txns = txns.filter(t => (t.symbol + ' ' + t.action + ' ' + (t.description||'')).toLowerCase().includes(search));
  if (actionFilter) txns = txns.filter(t => t.action === actionFilter);

  const tbody = document.querySelector('#tradesTable tbody');
  if (txns.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No trades match.</td></tr>';
    return;
  }
  tbody.innerHTML = txns.map(t => {
    const wash = washIds.has(t.id) ? '<span class="badge badge-wash">⚠ WASH?</span>' : '';
    const amtCls = t.amount && t.amount > 0 ? 'g' : t.amount && t.amount < 0 ? 'r' : 'n';
    return `<tr>
      <td>${t.date || t.rawDate}</td>
      <td style="color:var(--text1)">${t.action}</td>
      <td><span style="font-family:var(--mono);font-weight:700">${t.symbol}</span></td>
      <td>${instBadge(t.instrument, t.optionType)}</td>
      <td>${t.optionType ? (t.optionType === 'call' ? '<span class="badge badge-call">C</span>' : '<span class="badge badge-put">P</span>') : ''}</td>
      <td class="r">${t.quantity !== null ? t.quantity : '—'}</td>
      <td class="r">${t.price !== null ? '$' + t.price.toFixed(2) : '—'}</td>
      <td class="r">${t.fees ? '$' + t.fees.toFixed(2) : '—'}</td>
      <td class="r"><span class="pos ${amtCls}">${t.amount !== null ? fmt$(t.amount) : '—'}</span></td>
      <td>${wash}</td>
    </tr>`;
  }).join('');
}

