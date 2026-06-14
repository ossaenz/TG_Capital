function renderAudit() {
  const batchFilter = document.getElementById('auditBatchFilter').value;
  const search = (document.getElementById('auditSearch').value || '').toLowerCase();
  const dateStart = document.getElementById('auditDateStart').value;
  const dateEnd = document.getElementById('auditDateEnd').value;

  let txns = db.transactions;

  if (batchFilter) {
    txns = txns.filter(t => t.batchId === batchFilter);
  }
  if (dateStart || dateEnd) {
    txns = txns.filter(t => {
      const d = t.date || t.rawDate || '';
      if (dateStart && d < dateStart) return false;
      if (dateEnd && d > dateEnd) return false;
      return true;
    });
  }
  if (search) {
    txns = txns.filter(t => (t.symbol + ' ' + t.action + ' ' + (t.description||'')).toLowerCase().includes(search));
  }

  if (auditSortBy) {
    txns = txns.sort((a, b) => {
      let valA, valB;
      switch (auditSortBy) {
        case 'date':
          valA = a.date || a.rawDate || '';
          valB = b.date || b.rawDate || '';
          return auditSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        case 'action':
          valA = (a.action || '').toLowerCase();
          valB = (b.action || '').toLowerCase();
          return auditSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        case 'symbol':
          valA = (a.symbol || '').toLowerCase();
          valB = (b.symbol || '').toLowerCase();
          return auditSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        case 'qty':
          valA = a.quantity || 0;
          valB = b.quantity || 0;
          return auditSortAsc ? valA - valB : valB - valA;
        case 'price':
          valA = a.price || 0;
          valB = b.price || 0;
          return auditSortAsc ? valA - valB : valB - valA;
        case 'fees':
          valA = a.fees || 0;
          valB = b.fees || 0;
          return auditSortAsc ? valA - valB : valB - valA;
        case 'amount':
          valA = a.amount || 0;
          valB = b.amount || 0;
          return auditSortAsc ? valA - valB : valB - valA;
        case 'batch':
          valA = (a.batchId || '').toLowerCase();
          valB = (b.batchId || '').toLowerCase();
          return auditSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        default:
          return 0;
      }
    });
  }

  const deleteBtn = document.getElementById('auditDeleteBtn');
  if (deleteBtn) {
    deleteBtn.style.display = batchFilter ? 'block' : 'none';
  }

  document.getElementById('auditCount').textContent = txns.length + ' records' + (batchFilter ? ` in batch` : '');
  const tbody = document.querySelector('#auditTable tbody');
  if (txns.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No records.</td></tr>';
    return;
  }
  tbody.innerHTML = txns.map((t, i) => `<tr>
    <td style="color:var(--text2);font-family:var(--mono)">${i + 1}</td>
    <td>${t.date || t.rawDate}</td>
    <td style="color:var(--text1)">${t.action}</td>
    <td><span style="font-family:var(--mono)">${t.symbol}</span></td>
    <td class="r">${t.quantity !== null ? t.quantity : '—'}</td>
    <td class="r">${t.price !== null ? '$' + t.price.toFixed(2) : '—'}</td>
    <td class="r">${t.fees ? '$' + t.fees.toFixed(2) : '—'}</td>
    <td class="r">${t.amount !== null ? fmt$(t.amount) : '—'}</td>
    <td style="color:var(--text2);font-size:11px">${t.batchId || '—'}</td>
  </tr>`).join('');
}

function sortAudit(field) {
  if (auditSortBy === field) {
    auditSortAsc = !auditSortAsc;
  } else {
    auditSortBy = field;
    auditSortAsc = true;
  }
  renderAudit();
}

function populateAuditBatches() {
  const select = document.getElementById('auditBatchFilter');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="">All Batches</option>';
  db.importBatches.forEach(b => {
    const batchLabel = `${b.fileName || b.id} (${new Date(b.importedAt).toLocaleDateString()})`;
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = batchLabel;
    select.appendChild(opt);
  });
  select.value = currentValue;

  const deleteBtn = document.getElementById('auditDeleteBtn');
  if (deleteBtn) {
    deleteBtn.style.display = currentValue ? 'block' : 'none';
  }
}

function deleteSelectedBatch() {
  const batchId = document.getElementById('auditBatchFilter').value;
  if (!batchId) {
    alert('Please select a batch to delete.');
    return;
  }

  const batch = db.importBatches.find(b => b.id === batchId);
  if (!batch) return;

  const fileName = batch.fileName || batch.id;
  if (!confirm(`Delete all ${batch.total} transactions from batch "${fileName}"? This cannot be undone.`)) {
    return;
  }

  const beforeCount = db.transactions.length;
  db.transactions = db.transactions.filter(t => t.batchId !== batchId);
  db.importBatches = db.importBatches.filter(b => b.id !== batchId);

  saveDB(db);

  document.getElementById('auditBatchFilter').value = '';
  document.getElementById('auditSearch').value = '';
  document.getElementById('auditDateStart').value = '';
  document.getElementById('auditDateEnd').value = '';
  auditSortBy = null;
  auditSortAsc = true;
  populateAuditBatches();
  renderAudit();
  refreshAll();

  alert(`Deleted ${beforeCount - db.transactions.length} transactions from batch.`);
}

