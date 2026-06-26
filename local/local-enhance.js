/**
 * local-enhance.js  —  injected only in the local Docker build at /
 * Seeds the app with real trade data from SQLite and adds a live Schwab tab.
 * Never modifies the original webapp source files.
 */
(function () {
  'use strict';

  // ── 1. Seed app with real data from server SQLite ─────────────────────────
  async function seedFromServer() {
    try {
      const csvText = await fetch('/api/seed-db').then(r => {
        if (!r.ok) throw new Error('seed-db returned ' + r.status);
        return r.text();
      });
      if (typeof parseCSV !== 'function' || typeof importRecords !== 'function') return;
      const rows = parseCSV(csvText);
      if (!rows.length) return;
      const batchId = 'local-sqlite-seed';
      const result  = importRecords(rows, 'schwab-history.csv', batchId);
      // refreshAll is defined in main.js
      if (typeof refreshAll === 'function') refreshAll();
      const notice = document.getElementById('tg-local-seed-notice');
      if (notice) {
        notice.textContent = `⚡ Loaded ${result.added + result.dupes} records from local server`;
        notice.style.color = 'var(--green)';
      }
    } catch (e) {
      console.warn('[TG-Local] Seed from server failed:', e.message);
    }
  }

  // ── 2. Inject "⚡ Schwab" nav tab + view ──────────────────────────────────
  function injectSchwabTab() {
    if (document.getElementById('view-schwab')) return;

    // Nav button — sidebar
    const sidebar = document.querySelector('.sidebar-nav');
    if (sidebar) {
      const btn = document.createElement('button');
      btn.className = 'nav-btn';
      btn.setAttribute('data-label', 'Schwab Live');
      btn.setAttribute('data-tg-view', 'schwab');
      btn.onclick = () => showSchwabView();
      btn.innerHTML = '<span class="nav-ico">⚡</span><span class="nav-label">Schwab Live</span>';
      sidebar.appendChild(btn);
    }

    // View container
    const main = document.querySelector('main') || document.querySelector('.main-content') || document.body;
    const view = document.createElement('div');
    view.className = 'view';
    view.id = 'view-schwab';
    view.style.cssText = 'padding:20px;display:none;';
    view.innerHTML = buildSchwabViewHTML();
    main.appendChild(view);

    // Wire up events inside the view
    wireSchwabView(view);
  }

  function buildSchwabViewHTML() {
    return `
      <style>
        #view-schwab { color: var(--text0); font-family: inherit; }
        .sg-section { background: var(--bg1); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; }
        .sg-section h3 { margin: 0 0 14px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text2); }
        .sg-live-grid { display: flex; flex-wrap: wrap; gap: 12px; }
        .sg-live-card { flex: 1; min-width: 140px; background: var(--bg2); border-radius: 8px; padding: 12px 14px; }
        .sg-live-card .label { font-size: 11px; color: var(--text2); margin-bottom: 4px; }
        .sg-live-card .val { font-size: 18px; font-weight: 700; color: var(--text0); }
        .sg-live-card .val.pos { color: var(--green); }
        .sg-live-card .val.neg { color: var(--red); }
        .sg-sync-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .sg-btn { border: none; border-radius: 7px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .sg-btn-primary { background: var(--blue, #2563eb); color: #fff; }
        .sg-btn-secondary { background: var(--bg3); color: var(--text1); border: 1px solid var(--border); }
        #sg-sync-status { font-size: 12px; color: var(--text2); }
        .sg-filter-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
        .sg-filter-row select, .sg-filter-row input { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; color: var(--text0); font-size: 13px; }
        .sg-kpi-grid { display: flex; flex-wrap: wrap; gap: 10px; }
        .sg-kpi { flex: 1; min-width: 120px; background: var(--bg2); border-radius: 8px; padding: 10px 12px; }
        .sg-kpi .label { font-size: 11px; color: var(--text2); margin-bottom: 2px; }
        .sg-kpi .val { font-size: 20px; font-weight: 700; }
        .sg-kpi .val.pos { color: var(--green); }
        .sg-kpi .val.neg { color: var(--red); }
        .sg-chat-messages { height: 340px; overflow-y: auto; padding: 10px; background: var(--bg2); border-radius: 8px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px; }
        .sg-msg { max-width: 85%; padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
        .sg-msg.user { align-self: flex-end; background: var(--blue, #2563eb); color: #fff; }
        .sg-msg.ai { align-self: flex-start; background: var(--bg3); color: var(--text0); }
        .sg-msg.ai.thinking { opacity: .5; font-style: italic; }
        .sg-chat-input-row { display: flex; gap: 8px; }
        .sg-chat-input-row input { flex: 1; background: var(--bg2); border: 1px solid var(--border); border-radius: 7px; padding: 10px 14px; color: var(--text0); font-size: 13px; }
        .sg-chat-input-row input:focus { outline: none; border-color: var(--blue, #2563eb); }
        #sg-rag-badge { font-size: 11px; color: var(--text2); margin-top: 6px; }
        .sg-positions { width: 100%; border-collapse: collapse; font-size: 12px; }
        .sg-positions th { color: var(--text2); padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 11px; text-transform: uppercase; }
        .sg-positions td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
        .sg-positions tr:hover td { background: var(--bg2); }
        .pos-toggle { display: flex; gap: 6px; margin-bottom: 10px; }
        .pos-toggle button { border: 1px solid var(--border); border-radius: 5px; padding: 4px 12px; font-size: 12px; cursor: pointer; background: var(--bg2); color: var(--text1); }
        .pos-toggle button.active { background: var(--blue, #2563eb); color: #fff; border-color: transparent; }
      </style>

      <!-- Live Schwab Account -->
      <div class="sg-section">
        <h3>Live Account — Charles Schwab</h3>
        <div class="sg-live-grid" id="sg-live-grid">
          <div style="color:var(--text2);font-size:13px">Loading…</div>
        </div>
      </div>

      <!-- Sync Controls -->
      <div class="sg-section">
        <h3>Sync Schwab Transactions</h3>
        <div class="sg-sync-row">
          <button class="sg-btn sg-btn-primary" onclick="schwabSync(90)">Sync 90 days</button>
          <button class="sg-btn sg-btn-secondary" onclick="schwabSync(365)">Sync 12 months</button>
          <span id="sg-sync-status">Checking…</span>
        </div>
      </div>

      <!-- Analytics / Date Filter -->
      <div class="sg-section">
        <h3>Options Analytics</h3>
        <div class="sg-filter-row">
          <select id="sg-preset" onchange="sgApplyPreset(this.value)">
            <option value="">— select period —</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="ytd">Year to Date</option>
            <option value="1yr">Last 12 months</option>
            <option value="all">All Time</option>
          </select>
          <input type="date" id="sg-from" onchange="sgLoadDash()">
          <span style="color:var(--text2);font-size:13px">to</span>
          <input type="date" id="sg-to" onchange="sgLoadDash()">
        </div>
        <div class="sg-kpi-grid" id="sg-kpi-grid">
          <div style="color:var(--text2);font-size:13px">Select a period above</div>
        </div>
      </div>

      <!-- Open Positions -->
      <div class="sg-section">
        <h3>Open Positions (Live)</h3>
        <div class="pos-toggle">
          <button class="active" id="sg-pos-opt-btn" onclick="sgShowPos('options')">Options</button>
          <button id="sg-pos-stk-btn" onclick="sgShowPos('stock')">Stock</button>
        </div>
        <div id="sg-positions-wrap" style="overflow-x:auto">
          <div style="color:var(--text2);font-size:13px">Loading positions…</div>
        </div>
      </div>

      <!-- AI Chat -->
      <div class="sg-section">
        <h3>AI Trading Analyst — Plutus</h3>
        <div class="sg-chat-messages" id="sg-chat-messages">
          <div class="sg-msg ai">Hi! I'm Plutus, your AI trading analyst. Ask me anything about your trades — win rates, best tickers, patterns, strategy suggestions.</div>
        </div>
        <div class="sg-chat-input-row">
          <input type="text" id="sg-chat-input" placeholder="Ask about your trades…" onkeydown="if(event.key==='Enter') sgSendChat()">
          <button class="sg-btn sg-btn-primary" onclick="sgSendChat()">Send</button>
        </div>
        <div id="sg-rag-badge">Loading AI status…</div>
      </div>
    `;
  }

  function wireSchwabView(view) {
    // Analytics presets
    window.sgApplyPreset = function (preset) {
      const today = new Date();
      const fmt   = d => d.toISOString().slice(0, 10);
      const from  = document.getElementById('sg-from');
      const to    = document.getElementById('sg-to');
      if (!from || !to) return;
      to.value = fmt(today);
      if (preset === 'today')  { from.value = fmt(today); }
      else if (preset === '7d')  { const d = new Date(today); d.setDate(d.getDate() - 7);   from.value = fmt(d); }
      else if (preset === '30d') { const d = new Date(today); d.setDate(d.getDate() - 30);  from.value = fmt(d); }
      else if (preset === 'ytd') { from.value = today.getFullYear() + '-01-01'; }
      else if (preset === '1yr') { const d = new Date(today); d.setFullYear(d.getFullYear() - 1); from.value = fmt(d); }
      else if (preset === 'all') { from.value = ''; to.value = ''; }
      sgLoadDash();
    };

    window.sgLoadDash = async function () {
      const from = document.getElementById('sg-from')?.value || '';
      const to   = document.getElementById('sg-to')?.value   || '';
      const grid = document.getElementById('sg-kpi-grid');
      if (!grid) return;
      grid.innerHTML = '<div style="color:var(--text2);font-size:13px">Loading…</div>';
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to)   params.set('to', to);
        const d = await fetch('/api/dashboard?' + params).then(r => r.json());
        const s = d.stats || {};
        const pnl  = (v) => {
          const n = parseFloat(v) || 0;
          const cls = n >= 0 ? 'pos' : 'neg';
          return `<span class="val ${cls}">$${n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</span>`;
        };
        const pct = (v) => `<span class="val">${(parseFloat(v)||0).toFixed(1)}%</span>`;
        grid.innerHTML = [
          { label: 'Options P&L', val: pnl(s.netPnL) },
          { label: 'Stock P&L',   val: pnl(s.stockPnL) },
          { label: 'Win Rate',    val: pct(s.winRate) },
          { label: 'Profit Factor', val: `<span class="val">${(parseFloat(s.profitFactor)||0).toFixed(2)}</span>` },
          { label: 'Fees Paid',   val: pnl(-Math.abs(s.totalFees||0)) },
          { label: 'Avg Win',     val: `<span class="val pos">$${(parseFloat(s.avgGain)||0).toFixed(0)}</span>` },
          { label: 'Avg Loss',    val: `<span class="val neg">$${(parseFloat(s.avgLoss)||0).toFixed(0)}</span>` },
        ].map(k => `<div class="sg-kpi"><div class="label">${k.label}</div>${k.val}</div>`).join('');
      } catch (e) {
        grid.innerHTML = '<div style="color:var(--red);font-size:12px">Error: ' + e.message + '</div>';
      }
    };

    // Live positions toggle
    let posData = null;
    window.sgShowPos = function (type) {
      document.getElementById('sg-pos-opt-btn').classList.toggle('active', type === 'options');
      document.getElementById('sg-pos-stk-btn').classList.toggle('active', type === 'stock');
      if (posData) renderPositions(posData, type);
    };

    function renderPositions(data, type) {
      const wrap = document.getElementById('sg-positions-wrap');
      if (!wrap) return;
      const isOpt  = type === 'options';
      const items  = (data.positions || [])
        .filter(p => isOpt ? p.assetType === 'OPTION' : p.assetType !== 'OPTION')
        .sort((a, b) => Math.abs(b.openPnL) - Math.abs(a.openPnL));
      if (!items.length) { wrap.innerHTML = '<div style="color:var(--text2);font-size:13px;padding:10px">No ' + type + ' positions</div>'; return; }
      wrap.innerHTML = `<table class="sg-positions">
        <thead><tr>
          <th>Symbol</th><th>Qty</th><th>Avg Price</th><th>Mkt Value</th><th>Open P&L</th>
        </tr></thead>
        <tbody>${items.map(p => {
          const pnl = p.openPnL || 0;
          const cls = pnl >= 0 ? 'color:var(--green)' : 'color:var(--red)';
          return `<tr>
            <td style="font-weight:600">${p.symbol}</td>
            <td>${p.shortQty ? '-'+p.shortQty : p.longQty}</td>
            <td>$${(p.avgPrice||0).toFixed(2)}</td>
            <td>$${(p.marketValue||0).toFixed(0)}</td>
            <td style="${cls}">$${pnl.toFixed(2)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    }

    async function loadLiveAccount() {
      const grid = document.getElementById('sg-live-grid');
      if (!grid) return;
      try {
        const d   = await fetch('/api/account').then(r => r.json());
        const bal = d.balances || {};
        const fmt = (v) => '$' + (parseFloat(v)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        const pnlFmt = (v) => {
          const n = parseFloat(v)||0;
          const cls = n >= 0 ? 'color:var(--green)' : 'color:var(--red)';
          return `<span style="${cls}">$${Math.abs(n).toFixed(2)}</span>`;
        };
        grid.innerHTML = [
          { label: 'Net Liquidation', val: fmt(bal.liquidationValue) },
          { label: 'Buying Power',    val: fmt(bal.buyingPower) },
          { label: 'Cash Balance',    val: fmt(bal.cashBalance) },
          { label: 'Day P&L',         val: pnlFmt(bal.dayPnL) },
          { label: 'Open P&L',        val: pnlFmt(bal.openPnL) },
          { label: 'Positions',       val: `<span>${(d.positions||[]).length}</span>` },
        ].map(c => `<div class="sg-live-card"><div class="label">${c.label}</div><div class="val">${c.val}</div></div>`).join('');
        posData = d;
        sgShowPos('options');
      } catch {
        if (grid) grid.innerHTML = '<div style="color:var(--text2);font-size:13px">Schwab not connected — <a href="/auth" target="_blank" style="color:var(--blue,#3b82f6)">authenticate</a></div>';
      }
    }

    // AI chat
    const chatMsgs = document.getElementById('sg-chat-messages');
    let chatHistory = [];

    window.sgSendChat = async function () {
      const inp = document.getElementById('sg-chat-input');
      const msg = (inp?.value || '').trim();
      if (!msg) return;
      inp.value = '';
      addMsg('user', msg);
      const thinking = addMsg('ai', '…', true);
      try {
        const r = await fetch('/api/ai/chat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ message: msg, model: '0xroyce/plutus:latest', history: chatHistory }),
        }).then(r => r.json());
        thinking.remove();
        const reply = r.reply || r.error || 'No response';
        addMsg('ai', reply);
        chatHistory.push({ role: 'user', content: msg });
        chatHistory.push({ role: 'assistant', content: reply });
        if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
      } catch (e) {
        thinking.remove();
        addMsg('ai', 'Error: ' + e.message);
      }
    };

    function addMsg(role, text, isThinking = false) {
      if (!chatMsgs) return { remove: () => {} };
      const el = document.createElement('div');
      el.className = 'sg-msg ' + role + (isThinking ? ' thinking' : '');
      el.textContent = text;
      chatMsgs.appendChild(el);
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
      return el;
    }

    // RAG status badge
    async function loadRagStatus() {
      const badge = document.getElementById('sg-rag-badge');
      if (!badge) return;
      try {
        const s = await fetch('/api/rag/status').then(r => r.json());
        const pct = s.total ? Math.round(s.withEmbeddings / s.total * 100) : 0;
        badge.innerHTML = `Model: <strong>0xroyce/plutus</strong> &nbsp;·&nbsp; RAG: <strong>${s.total} docs (${pct}% embedded)</strong>
          &nbsp;·&nbsp; <a href="#" onclick="sgIndexRag();return false" style="color:var(--blue,#3b82f6);font-size:11px">Re-index</a>`;
      } catch {
        badge.textContent = 'AI status unavailable';
      }
    }

    window.sgIndexRag = async function () {
      const badge = document.getElementById('sg-rag-badge');
      if (badge) badge.textContent = 'Indexing…';
      await fetch('/api/rag/index', { method: 'POST' }).catch(() => {});
      setTimeout(loadRagStatus, 3000);
    };

    // On view activation
    view._load = function () {
      loadLiveAccount();
      loadRagStatus();
      pollSchwabStatus();
    };
  }

  function showSchwabView() {
    if (typeof showView === 'function') {
      // Temporarily override for our custom view
    }
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    const sv = document.getElementById('view-schwab');
    if (sv) { sv.style.display = 'block'; sv._load && sv._load(); }
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('[data-tg-view="schwab"]').forEach(b => b.classList.add('active'));
  }

  // Patch showView so native nav buttons still work
  function patchShowView() {
    const orig = window.showView;
    if (!orig || orig._patched) return;
    window.showView = function (id) {
      if (id === 'schwab') { showSchwabView(); return; }
      // Hide our custom view, show original views normally
      const sv = document.getElementById('view-schwab');
      if (sv) sv.style.display = 'none';
      orig(id);
    };
    window.showView._patched = true;
  }

  // ── 3. Schwab sync panel in Import tab (for manual syncs) ─────────────────
  function injectSchwabPanel() {
    if (document.getElementById('schwab-local-panel')) return;
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;
    const card   = dropZone.closest('.card');
    const anchor = card || dropZone.closest('[style*="padding"]') || dropZone.parentNode;

    const panel = document.createElement('div');
    panel.id = 'schwab-local-panel';
    panel.style.cssText = 'background:var(--bg1);border:1px solid var(--border);border-radius:10px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;';
    panel.innerHTML = `
      <div style="flex:1;min-width:200px">
        <div style="font-size:13px;font-weight:700;color:var(--green);margin-bottom:4px">⚡ Schwab Live Sync</div>
        <div id="schwab-sync-status" style="font-size:12px;color:var(--text2)">Checking connection…</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="schwabSync(90)"  style="background:#2563eb;color:#fff;border:none;border-radius:7px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer">Sync 90 days</button>
        <button onclick="schwabSync(365)" style="background:var(--bg3);color:var(--text1);border:1px solid var(--border);border-radius:7px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer">Sync 12 months</button>
      </div>`;
    anchor.parentNode.insertBefore(panel, anchor);
  }

  // ── 4. Schwab status polling ───────────────────────────────────────────────
  let pollTimer = null;
  function pollSchwabStatus() {
    clearTimeout(pollTimer);
    (async () => {
      try {
        const s  = await fetch('/api/status').then(r => r.json());
        const el1 = document.getElementById('schwab-sync-status');
        const el2 = document.getElementById('sg-sync-status');
        const msg = s.authed
          ? (s.running
              ? '⏳ Syncing…'
              : s.lastRun
                ? `✓ Connected · Last sync: ${new Date(s.lastRun).toLocaleString()} · ${s.lastCount ?? '?'} rows`
                : '✓ Connected — click Sync to pull transactions')
          : '<a href="/auth" target="_blank" style="color:#3b82f6">Not connected — authenticate</a>';
        if (el1) el1.innerHTML = msg;
        if (el2) el2.innerHTML = msg;
        if (s.running && window._schwabWasRunning) {
          // Just finished — re-seed the app
          window._schwabWasRunning = false;
          await seedFromServer();
        }
      } catch {
        ['schwab-sync-status', 'sg-sync-status'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = '<span style="color:var(--red)">Local server not reachable</span>';
        });
      }
      pollTimer = setTimeout(pollSchwabStatus, s?.running ? 2000 : 30000);
    })();
  }
  // Make s accessible in the catch block
  let s = {};

  // ── 5. Sync trigger ────────────────────────────────────────────────────────
  window.schwabSync = async function (days) {
    ['schwab-sync-status','sg-sync-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '⏳ Starting sync…';
    });
    window._schwabWasRunning = true;
    clearTimeout(pollTimer);
    try { await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) }); } catch {}
    pollSchwabStatus();
  };

  // ── 6. Sync journal entries to server ─────────────────────────────────────
  async function syncJournalToServer() {
    try {
      if (typeof db === 'undefined') return;
      const entries = db.journalEntries || [];
      if (!entries.length) return;
      await fetch('/api/journal', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ entries }),
      });
    } catch (e) {
      console.warn('[TG-Local] Journal sync skipped:', e.message);
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    // Add seed status notice to top of page
    const header = document.querySelector('.top-bar, header, .navbar') || document.body.firstElementChild;
    if (header) {
      const notice = document.createElement('div');
      notice.id = 'tg-local-seed-notice';
      notice.style.cssText = 'font-size:11px;padding:3px 12px;background:var(--bg1);border-bottom:1px solid var(--border);color:var(--text2);';
      notice.textContent = '⚡ Local server — loading trade data…';
      document.body.insertBefore(notice, document.body.firstChild);
    }

    patchShowView();
    injectSchwabTab();
    injectSchwabPanel();
    await seedFromServer();
    syncJournalToServer();
    pollSchwabStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
