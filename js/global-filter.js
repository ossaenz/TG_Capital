'use strict';

// Global date range state (shared across all views)
let globalDateStart = null;
let globalDateEnd = null;

function applyGlobalFilter() {
  const yearSel = document.getElementById('globalYearSelect')?.value;
  const startDate = document.getElementById('globalDateStart')?.value;
  const endDate = document.getElementById('globalDateEnd')?.value;

  if (yearSel) {
    globalDateStart = `${yearSel}-01-01`;
    globalDateEnd = `${yearSel}-12-31`;
  } else {
    globalDateStart = startDate || null;
    globalDateEnd = endDate || null;
  }

  // Sync dashboard variables
  if (typeof dashboardDateStart !== 'undefined') {
    dashboardDateStart = globalDateStart;
    dashboardDateEnd = globalDateEnd;
    updateDashboardFilterLabel();
  }

  // Refresh current view
  refreshAll();
}

function resetGlobalFilter() {
  globalDateStart = null;
  globalDateEnd = null;
  document.getElementById('globalYearSelect').value = '';
  document.getElementById('globalDateStart').value = '';
  document.getElementById('globalDateEnd').value = '';

  // Sync dashboard
  if (typeof dashboardDateStart !== 'undefined') {
    dashboardDateStart = null;
    dashboardDateEnd = null;
    updateDashboardFilterLabel();
  }

  // Refresh current view
  refreshAll();
}

// Populate year selector (called after data loads)
function initGlobalYearSelect() {
  const yearSel = document.getElementById('globalYearSelect');
  if (!yearSel || !window.trades) return;

  // Clear existing options (keep "All Years")
  while (yearSel.children.length > 1) {
    yearSel.removeChild(yearSel.lastChild);
  }

  const allYears = new Set();
  for (const trade of trades) {
    const year = trade.date.split('-')[0];
    if (year) allYears.add(year);
  }

  const sorted = Array.from(allYears).sort().reverse();
  sorted.forEach(year => {
    const opt = document.createElement('option');
    opt.value = year;
    opt.textContent = year;
    yearSel.appendChild(opt);
  });
}

// Hook into data load cycle
const origRefreshAll = window.refreshAll;
window.refreshAll = function(...args) {
  initGlobalYearSelect();
  return origRefreshAll?.apply(this, args);
};

