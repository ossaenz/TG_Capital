// ════════════════════════════════════════════════════════
// VIEW ROUTING
// ════════════════════════════════════════════════════════
function openAdvancedWashSalesPage() {
  try {
    const payload = JSON.stringify(sanitizeDB(db));
    sessionStorage.setItem('tgcapital_adv_wash_payload_v1', payload);
    sessionStorage.setItem('tgcapital_adv_wash_payload_ts', new Date().toISOString());
  } catch (err) {
    console.warn('Advanced wash payload save failed:', err.message);
  }
  window.open('advanced-wash-sales.html', '_blank', 'noopener');
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const btns = document.querySelectorAll('.nav-btn');
  btns.forEach(b => { if (b.getAttribute('onclick').includes(id)) b.classList.add('active'); });
  if (id === 'performance') renderPerformance();
  else if (id === 'positions') renderPositions();
  else if (id === 'closed') renderClosedPositions();
  else if (id === 'trades') renderTradeTable();
  else if (id === 'journal') renderJournal();
  else if (id === 'journal-report') renderJournalReport();
  else if (id === 'washsales') renderWashSales();
  else if (id === 'import') renderImportHistory();
  else if (id === 'audit') { populateAuditBatches(); renderAudit(); }
  else if (id === 'dashboard') renderDashboard();
  else if (id === 'reports') renderReports();
}

function refreshAll() {
  populateYearSelects();
  renderDashboard();
  renderPerformance();
  renderClosedPositions();
  renderPositions();
  renderTradeTable();
  renderJournal();
  renderWashSales();
  renderImportHistory();
  populateAuditBatches();
  renderAudit();
  // Only re-render visible report tabs
  if (document.getElementById('view-journal-report')?.classList.contains('active')) renderJournalReport();
  if (document.getElementById('view-reports')?.classList.contains('active')) renderReports();
}


// Initial render
refreshAll();
updateDriveAutoToggleUI();
updateLocalDiskModeUI();
setTimeout(() => {
  maybeAutoConnectDriveOnLoad().catch(err => {
    setFsStatus('! Drive auto-connect failed: ' + err.message, 'var(--red)');
  });
}, 200);
