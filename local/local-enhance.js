/**
 * local-enhance.js  —  injected only in the local Docker build
 * Adds Schwab auto-sync UI to the existing app without modifying any
 * original source files.
 */
(function () {
  'use strict';

  // ── Schwab sync panel injected above the CSV import drop-zone ─────────────
  function injectSchwabPanel() {
    // Find the import section's drop zone
    const dropZone = document.getElementById('dropZone') || document.querySelector('.drop-zone');
    if (!dropZone) return;

    const panel = document.createElement('div');
    panel.id = 'schwab-local-panel';
    panel.style.cssText = `
      background: #1a1d27;
      border: 1px solid #2a3a2a;
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 18px;
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    `;
    panel.innerHTML = `
      <div style="flex:1;min-width:200px">
        <div style="font-size:13px;font-weight:700;color:#4caf50;margin-bottom:3px">
          ⚡ Schwab Live Sync
        </div>
        <div id="schwab-sync-status" style="font-size:12px;color:#6b7280">
          Checking connection…
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="btn-schwab-sync-90" onclick="schwabSync(90)" style="
          background:#2563eb;color:#fff;border:none;border-radius:7px;
          padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer">
          Sync 90 days
        </button>
        <button id="btn-schwab-sync-365" onclick="schwabSync(365)" style="
          background:#1e2d3a;color:#7dd3fc;border:1px solid #2a4a6a;border-radius:7px;
          padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer">
          Sync 12 months
        </button>
      </div>
    `;
    dropZone.parentNode.insertBefore(panel, dropZone);
    pollSchwabStatus();
  }

  // ── Status polling ────────────────────────────────────────────────────────
  let pollTimer = null;
  async function pollSchwabStatus() {
    try {
      const s   = await fetch('/api/status').then(r => r.json());
      const el  = document.getElementById('schwab-sync-status');
      if (!el) return;

      if (!s.authed) {
        el.innerHTML = `<span style="color:#f44336">Not connected — </span>
          <a href="/auth" target="_blank" style="color:#3b82f6">authenticate here</a>`;
      } else if (s.running) {
        el.innerHTML = `<span style="color:#f59e0b">⏳ Syncing…</span>`;
        pollTimer = setTimeout(pollSchwabStatus, 1500);
        return;
      } else if (s.lastRun) {
        const t = new Date(s.lastRun).toLocaleString();
        el.innerHTML = `<span style="color:#4caf50">✓ Connected</span>
          &nbsp;·&nbsp; Last sync: ${t}
          &nbsp;·&nbsp; ${s.lastCount ?? '?'} rows`;
        // If a sync just finished, auto-import the CSV
        if (window._schwabWasRunning) {
          window._schwabWasRunning = false;
          autoImportCSV();
        }
      } else {
        el.innerHTML = `<span style="color:#4caf50">✓ Connected</span> — click Sync to pull transactions`;
      }
    } catch {
      const el = document.getElementById('schwab-sync-status');
      if (el) el.innerHTML = `<span style="color:#f44336">Local server not reachable</span>`;
    }
    pollTimer = setTimeout(pollSchwabStatus, 30000);
  }

  // ── Trigger sync ──────────────────────────────────────────────────────────
  window.schwabSync = async function (days) {
    const el = document.getElementById('schwab-sync-status');
    if (el) el.innerHTML = `<span style="color:#f59e0b">⏳ Starting sync…</span>`;
    window._schwabWasRunning = true;
    clearTimeout(pollTimer);
    try {
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
      });
    } catch {}
    pollSchwabStatus();
  };

  // ── Auto-import CSV into the app after sync completes ────────────────────
  async function autoImportCSV() {
    const statusEl = document.getElementById('schwab-sync-status');
    if (statusEl) statusEl.innerHTML += ' &nbsp;·&nbsp; <span style="color:#f59e0b">Importing…</span>';

    try {
      const csvText = await fetch('/api/csv-text').then(r => {
        if (!r.ok) throw new Error('no csv');
        return r.text();
      });

      // Use the existing app's importRecords pipeline
      if (typeof parseCSV === 'function' && typeof importRecords === 'function') {
        const batchId = 'schwab-auto-' + Date.now();
        const rows    = parseCSV(csvText);
        const result  = importRecords(rows, 'schwab-auto-import.csv', batchId);
        saveDB(db);

        // Refresh all views
        if (typeof renderPositions       === 'function') renderPositions();
        if (typeof renderClosedPositions === 'function') renderClosedPositions();
        if (typeof renderJournal         === 'function') renderJournal();

        if (statusEl) statusEl.innerHTML = `
          <span style="color:#4caf50">✓ Imported ${result.added} new, ${result.dupes} dupes skipped</span>`;

        addLog(`Schwab auto-sync: ${result.added} new transactions imported`, 'success');
      } else {
        // Fallback: trigger file-input import with the CSV blob
        const blob = new Blob([csvText], { type: 'text/csv' });
        const file = new File([blob], 'schwab-auto-import.csv', { type: 'text/csv' });
        const dt   = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('csvFileInput') || document.querySelector('input[type=file]');
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (statusEl) statusEl.innerHTML = `<span style="color:#4caf50">✓ Sync complete — review import above</span>`;
      }
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<span style="color:#f44336">Import failed: ${e.message}</span>`;
    }
  }

  // ── Boot: wait for DOM then inject ───────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSchwabPanel);
  } else {
    injectSchwabPanel();
  }
})();
