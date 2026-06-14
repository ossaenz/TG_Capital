'use strict';

// ════════════════════════════════════════════════════════
// STORAGE — local file and Google Drive (metadata only in localStorage)
// ════════════════════════════════════════════════════════
const STORAGE_META_KEY = 'tgcapital_storage_meta_v1';
const FS_SUPPORTED = ('showOpenFilePicker' in window);
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_DATA_FILE_NAME = 'tgcapital-data.json';
const LOCAL_CONFIG_FILE_NAME = 'tgcapital-config.json';

let fileHandle = null;        // FileSystemFileHandle — session only
let saveTimer = null;         // debounce handle
let unsaved = false;

let storageMeta = loadStorageMeta();
let appConfig = null;
let gapiClientReady = false;
let driveAccessToken = null;

function createEmptyDB() {
  return { transactions: [], importBatches: [], journalEntries: [], version: 4 };
}

function coerceJSONToDB(parsed, sourceName) {
  const container = parsed?.db || parsed?.data || parsed?.payload || parsed?.appData || parsed;

  if (container && Array.isArray(container.transactions)) {
    return sanitizeDB(container);
  }

  const temp = createEmptyDB();
  const batchId = 'batch_open_' + Date.now();

  const toSchwabLikeRow = (row) => {
    if (!row || typeof row !== 'object') return null;

    const date = row['Date'] ?? row.date ?? row.tradeDate ?? row.transactionDate ?? '';
    const action = row['Action'] ?? row.action ?? row.type ?? row.activity ?? '';
    const symbol = row['Symbol'] ?? row.symbol ?? row.ticker ?? row.underlying ?? '';
    const description = row['Description'] ?? row.description ?? row.desc ?? '';
    const quantity = row['Quantity'] ?? row.quantity ?? row.qty ?? '';
    const price = row['Price'] ?? row.price ?? '';
    const fees = row['Fees & Comm'] ?? row.fees ?? row.commission ?? row.fee ?? '';
    const amount = row['Amount'] ?? row.amount ?? row.netAmount ?? '';
    const acctgRuleCd = row['AcctgRuleCd'] ?? row.acctgRuleCd ?? '';

    if (!action && !symbol) return null;
    return {
      Date: String(date || ''),
      Action: String(action || ''),
      Symbol: String(symbol || ''),
      Description: String(description || ''),
      Quantity: quantity,
      Price: price,
      'Fees & Comm': fees,
      Amount: amount,
      AcctgRuleCd: acctgRuleCd,
    };
  };

  const rawRows = Array.isArray(container?.BrokerageTransactions)
    ? container.BrokerageTransactions
    : Array.isArray(container?.transactions)
      ? container.transactions
      : Array.isArray(container?.rows)
        ? container.rows
        : Array.isArray(container?.items)
          ? container.items
          : Array.isArray(parsed)
            ? parsed
            : null;

  if (rawRows) {
    const imported = [];
    for (const raw of rawRows) {
      const normalized = toSchwabLikeRow(raw);
      if (!normalized) continue;
      const t = normalizeRow(normalized, batchId);
      if (!t.symbol && !t.action) continue;
      imported.push(t);
    }
    temp.transactions = dedupeTransactions(imported);
    temp.importBatches.push({
      id: batchId,
      fileName: sourceName,
      importedAt: new Date().toISOString(),
      total: rawRows.length,
      added: temp.transactions.length,
      dupes: Math.max(0, rawRows.length - temp.transactions.length),
    });
    return sanitizeDB(temp);
  }

  // Legacy Money Bags export compatibility.
  if (container && Array.isArray(container.optionTrades)) {
    const txns = [];
    for (const trade of container.optionTrades) {
      if (trade?.stoDate && trade?.fullSymbol) {
        const sym = sanitizeSymbol(trade.fullSymbol, 'Sell to Open');
        const opt = parseOptionSymbol(sym);
        txns.push(sanitizeTransaction({
          rawDate: trade.stoDate,
          date: parseDate(trade.stoDate),
          action: 'Sell to Open',
          symbol: sym,
          description: 'Legacy option open',
          quantity: 1,
          price: trade.stoPrice ?? null,
          fees: trade.stoFees || 0,
          amount: trade.stoAmt ?? null,
          instrument: classifyInstrument(sym, 'Sell to Open'),
          optionType: opt ? opt.optionType : null,
          underlying: opt ? opt.underlying : null,
          strike: opt ? opt.strike : null,
          expiry: opt ? opt.expiry : null,
          direction: 'short',
          batchId,
        }));
      }

      if (trade?.btcDate && trade?.fullSymbol) {
        const sym = sanitizeSymbol(trade.fullSymbol, 'Buy to Close');
        const opt = parseOptionSymbol(sym);
        txns.push(sanitizeTransaction({
          rawDate: trade.btcDate,
          date: parseDate(trade.btcDate),
          action: 'Buy to Close',
          symbol: sym,
          description: 'Legacy option close',
          quantity: 1,
          price: trade.btcPrice ?? null,
          fees: trade.btcFees || 0,
          amount: trade.btcAmt ?? null,
          instrument: classifyInstrument(sym, 'Buy to Close'),
          optionType: opt ? opt.optionType : null,
          underlying: opt ? opt.underlying : null,
          strike: opt ? opt.strike : null,
          expiry: opt ? opt.expiry : null,
          direction: 'short',
          batchId,
        }));
      }
    }

    if (Array.isArray(container.dividends)) {
      for (const div of container.dividends) {
        const sym = sanitizeSymbol(div?.symbol, 'Cash Dividend');
        if (!sym || !div?.date) continue;
        txns.push(sanitizeTransaction({
          rawDate: div.date,
          date: parseDate(div.date),
          action: 'Cash Dividend',
          symbol: sym,
          description: 'Legacy ETF dividend',
          quantity: null,
          price: null,
          fees: 0,
          amount: Number(div.amount || 0),
          instrument: classifyInstrument(sym, 'Cash Dividend'),
          optionType: null,
          underlying: sym,
          strike: null,
          expiry: null,
          direction: null,
          batchId,
        }));
      }
    }

    temp.transactions = dedupeTransactions(txns);
    temp.importBatches.push({
      id: batchId,
      fileName: sourceName + ' (legacy)',
      importedAt: new Date().toISOString(),
      total: txns.length,
      added: temp.transactions.length,
      dupes: Math.max(0, txns.length - temp.transactions.length),
    });
    return sanitizeDB(temp);
  }

  return null;
}

function loadStorageMeta() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_META_KEY) || '{}');
    return {
      preferredBackend: parsed.preferredBackend || null,
      driveFileId: parsed.driveFileId || null,
      driveFileName: parsed.driveFileName || null,
      localFileName: parsed.localFileName || null,
      autoDriveConnect: parsed.autoDriveConnect !== false,
      localDiskMode: parsed.localDiskMode === true,
    };
  } catch {
    return { preferredBackend: null, driveFileId: null, driveFileName: null, localFileName: null, autoDriveConnect: true, localDiskMode: false };
  }
}

function saveStorageMeta() {
  try { localStorage.setItem(STORAGE_META_KEY, JSON.stringify(storageMeta)); } catch {}
  updateBackendBadge();
  updateDriveAutoToggleUI();
  updateLocalDiskModeUI();
}

function updateDriveAutoToggleUI() {
  const btn = document.getElementById('btnDriveAuto');
  if (!btn) return;
  const on = storageMeta.autoDriveConnect !== false;
  btn.textContent = on ? 'Auto Drive: ON' : 'Auto Drive: OFF';
  btn.style.opacity = on ? '1' : '0.75';
}

function updateLocalDiskModeUI() {
  const btn = document.getElementById('btnLocalDiskMode');
  if (!btn) return;
  const on = storageMeta.localDiskMode === true;
  btn.textContent = on ? 'Local Disk Mode: ON' : 'Local Disk Mode: OFF';
  btn.style.opacity = on ? '1' : '0.8';
}

function toggleLocalDiskMode() {
  storageMeta.localDiskMode = !(storageMeta.localDiskMode === true);
  if (storageMeta.localDiskMode) {
    storageMeta.preferredBackend = 'file';
    storageMeta.autoDriveConnect = false;
  }
  saveStorageMeta();
  updateLocalDiskModeUI();
  if (storageMeta.localDiskMode) {
    setFsStatus('Local Disk Mode enabled — Google Drive sync is disabled', 'var(--green)');
  } else {
    setFsStatus('Local Disk Mode disabled — Google Drive is available again', 'var(--accent)');
  }
}

function makeConfigSnapshot() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    app: 'TGCapital',
    storageMeta: {
      preferredBackend: storageMeta.preferredBackend || null,
      driveFileId: storageMeta.driveFileId || null,
      driveFileName: storageMeta.driveFileName || null,
      localFileName: storageMeta.localFileName || null,
      autoDriveConnect: storageMeta.autoDriveConnect !== false,
      localDiskMode: storageMeta.localDiskMode === true,
    },
  };
}

function applyConfigSnapshot(cfg) {
  const meta = cfg && typeof cfg === 'object' ? (cfg.storageMeta || cfg) : null;
  if (!meta || typeof meta !== 'object') throw new Error('Invalid config file format');

  storageMeta.preferredBackend = meta.preferredBackend || null;
  storageMeta.driveFileId = meta.driveFileId || null;
  storageMeta.driveFileName = meta.driveFileName || null;
  storageMeta.localFileName = meta.localFileName || null;
  storageMeta.autoDriveConnect = meta.autoDriveConnect !== false;
  storageMeta.localDiskMode = meta.localDiskMode === true;

  if (storageMeta.localDiskMode) {
    storageMeta.preferredBackend = 'file';
    storageMeta.autoDriveConnect = false;
  }

  saveStorageMeta();
  updateLocalDiskModeUI();
}

async function saveLocalConfigFile() {
  if (!FS_SUPPORTED) {
    setFsStatus('Local config save requires Chrome/Edge File System Access API', 'var(--amber)');
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: LOCAL_CONFIG_FILE_NAME,
      types: [{ description: 'TGCapital Config', accept: { 'application/json': ['.json'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(makeConfigSnapshot(), null, 2));
    await writable.close();
    setFsStatus('✓ Config saved to disk: ' + (handle.name || LOCAL_CONFIG_FILE_NAME), 'var(--green)');
  } catch (err) {
    if (err.name !== 'AbortError') setFsStatus('! Config save failed: ' + err.message, 'var(--red)');
  }
}

async function openLocalConfigFile() {
  if (!FS_SUPPORTED) {
    setFsStatus('Local config load requires Chrome/Edge File System Access API', 'var(--amber)');
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'TGCapital Config', accept: { 'application/json': ['.json'] } }],
      multiple: false,
    });
    const file = await handle.getFile();
    const parsed = JSON.parse(await file.text());
    applyConfigSnapshot(parsed);
    setFsStatus('✓ Config loaded from disk: ' + (handle.name || LOCAL_CONFIG_FILE_NAME), 'var(--green)');
  } catch (err) {
    if (err.name !== 'AbortError') setFsStatus('! Config load failed: ' + err.message, 'var(--red)');
  }
}

function toggleAutoDriveConnect() {
  storageMeta.autoDriveConnect = !(storageMeta.autoDriveConnect !== false);
  saveStorageMeta();
  if (storageMeta.autoDriveConnect !== false) {
    setFsStatus('Auto Drive enabled — app will auto-connect and restore on startup', 'var(--green)');
  } else {
    setFsStatus('Auto Drive disabled — app will ask before Drive restore on startup', 'var(--amber)');
  }
}

function loadDB() {
  return createEmptyDB();
}

function queueAutoSave(task, label) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await task();
    } catch (err) {
      setFsStatus('! Auto-save failed (' + label + '): ' + err.message, 'var(--red)');
    }
  }, 250);
}

// ── Write ───────────────────────────────────────────────
function saveDB(data) {
  db = sanitizeDB(data);
  if (fileHandle) {
    queueAutoSave(() => writeToDisk(db), 'file');
    return;
  }

  if (storageMeta.localDiskMode === true) {
    setFsStatus('! Local Disk Mode is ON. Click 💾 Save to write to local file.', 'var(--amber)');
    unsaved = true;
    return;
  }

  if (storageMeta.driveFileId) {
    queueAutoSave(() => syncToGoogleDrive('auto'), 'drive');
    return;
  }

  if (storageMeta.preferredBackend === 'drive') {
    setFsStatus('! Drive selected but not linked. Click Connect Drive.', 'var(--amber)');
  } else {
    setFsStatus('! Unsaved. Click Save (file) or Connect Drive.', 'var(--amber)');
  }
  unsaved = true;
}

// ── Disk write ───────────────────────────────────────────
async function writeToDisk(data) {
  if (!fileHandle) return;
  try {
    saveLocalBackup();
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    storageMeta.preferredBackend = 'file';
    storageMeta.localFileName = fileHandle.name || storageMeta.localFileName;
    saveStorageMeta();
    unsaved = false;
    setFsStatus('✓ Saved — ' + new Date().toLocaleTimeString(), 'var(--green)');
  } catch (err) {
    setFsStatus('⚠ Save failed: ' + err.message, 'var(--red)');
  }
}

// ── Open existing .json data file ───────────────────────
async function openDataFile() {
  if (!FS_SUPPORTED) { alert('File System Access API requires Chrome/Edge 86+. Use the Export button instead.'); return; }
  try {
    const handles = await window.showOpenFilePicker({
      types: [{ description: 'TGCapital Data & CSV', accept: { 'application/json': ['.json'], 'text/csv': ['.csv'] } }],
      multiple: true,
    });
    
    if (handles.length === 0) return;
    
    addLog(``, '');
    addLog(`Opening ${handles.length} file(s)...`, 'info');
    
    let totalAdded = 0, totalDupes = 0, totalRows = 0;
    
    // Process files sequentially
    const processNext = (index) => {
      if (index >= handles.length) {
        addLog(``, '');
        addLog(`All files processed!`, 'ok');
        addLog(`Total: ${totalRows} rows, ${totalAdded} imported, ${totalDupes} dupes skipped`, 'ok');
        addLog(`Database now has: ${db.transactions.length} transactions`, 'info');
        storageMeta.preferredBackend = 'file';
        saveStorageMeta();
        unsaved = true;
        refreshAll();
        return;
      }
      
      const handle = handles[index];
      handle.getFile().then(async file => {
        const text = await file.text();
        const fileName = handle.name;
        
        try {
          // Determine if CSV or JSON
          if (fileName.endsWith('.csv')) {
            const rows = normalizeImportedCsvRows(fileName, parseCSV(text));
            const { added, dupes } = importRecords(rows, fileName, 'batch_' + Date.now() + '_' + index);
            totalAdded += added;
            totalDupes += dupes;
            totalRows += rows.length;
            addLog(`✓ ${fileName}: ${rows.length} rows (${added} new, ${dupes} dupes)`, 'ok');
          } else {
            const parsed = JSON.parse(text);
            const coerced = coerceJSONToDB(parsed, fileName);
            if (!coerced) throw new Error('Invalid format');
            // Merge: append transactions not already present (use strict ID-based dedup)
            const beforeCount = db.transactions.length;
            const existingIds = new Set(db.transactions.map(t => t.id));
            for (const txn of coerced.transactions || []) {
              if (existingIds.has(txn.id)) {
                totalDupes++;
              } else {
                db.transactions.push(txn);
                existingIds.add(txn.id);
                totalAdded++;
              }
            }
            // CRITICAL: Deduplicate after JSON merge (matches CSV import behavior)
            db.transactions = dedupeTransactions(db.transactions);
            totalRows += coerced.transactions?.length || 0;
            addLog(`✓ ${fileName}: ${coerced.transactions?.length || 0} records (${totalAdded - (beforeCount > 0 ? totalAdded - (coerced.transactions?.length || 0) : totalAdded)} new, ${totalDupes} dupes)`, 'ok');
          }
        } catch (err) {
          addLog(`✗ ${fileName}: ${err.message}`, 'err');
        }
        
        processNext(index + 1);
      });
    };
    
    processNext(0);
  } catch (err) {
    if (err.name !== 'AbortError') setFsStatus('⚠ ' + err.message, 'var(--red)');
  }
}

// ── Save / Save As ───────────────────────────────────────
async function saveDataFile() {
  if (storageMeta.localDiskMode === true) {
    if (!FS_SUPPORTED) {
      exportJSON();
      return;
    }
    try {
      if (!fileHandle) {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: 'tgcapital-data.json',
          types: [{ description: 'TGCapital Data', accept: { 'application/json': ['.json'] } }],
        });
        storageMeta.localFileName = fileHandle.name || null;
      }
      storageMeta.preferredBackend = 'file';
      saveStorageMeta();
      await writeToDisk(db);
    } catch (err) {
      if (err.name !== 'AbortError') setFsStatus('⚠ ' + err.message, 'var(--red)');
    }
    return;
  }

  if (storageMeta.preferredBackend === 'drive' && storageMeta.driveFileId) {
    try {
      await syncToGoogleDrive('manual');
      setFsStatus('✓ Synced to Drive — ' + new Date().toLocaleTimeString(), 'var(--green)');
    } catch (err) {
      setFsStatus('! Drive save failed: ' + err.message, 'var(--red)');
    }
    return;
  }

  if (!FS_SUPPORTED) {
    if (storageMeta.driveFileId) {
      try {
        await syncToGoogleDrive('manual');
        setFsStatus('✓ Synced to Drive — ' + new Date().toLocaleTimeString(), 'var(--green)');
      } catch (err) {
        setFsStatus('! Drive save failed: ' + err.message, 'var(--red)');
      }
    } else {
      exportJSON();
    }
    return;
  }

  try {
    if (!fileHandle) {
      // First save — prompt user to pick location
      fileHandle = await window.showSaveFilePicker({
        suggestedName: 'tgcapital-data.json',
        types: [{ description: 'TGCapital Data', accept: { 'application/json': ['.json'] } }],
      });
      storageMeta.localFileName = fileHandle.name || null;
      storageMeta.preferredBackend = 'file';
      saveStorageMeta();
    }
    await writeToDisk(db);
  } catch (err) {
    if (err.name !== 'AbortError') setFsStatus('⚠ ' + err.message, 'var(--red)');
  }
}

// ── Export fallback (non-Chrome) ─────────────────────────
function exportJSON() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tgcapital-data.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function setFsStatus(msg, color) {
  const el = document.getElementById('fsStatus');
  if (el) { el.textContent = msg; el.style.color = color || 'var(--text2)'; }
  updateBackendBadge();
}

function updateBackendBadge() {
  const el = document.getElementById('backendBadge');
  if (!el) return;

  let label = 'Backend: none';
  let fg = 'var(--text2)';
  let bg = 'var(--bg3)';
  let border = 'var(--border)';

  if (fileHandle) {
    label = 'Backend: file active';
    fg = 'var(--green)';
    bg = 'var(--green-dim)';
    border = 'var(--green)';
  } else if (storageMeta.localDiskMode === true) {
    label = 'Backend: local disk mode';
    fg = 'var(--green)';
    bg = 'var(--green-dim)';
    border = 'var(--green)';
  } else if (storageMeta.driveFileId) {
    label = driveAccessToken ? 'Backend: drive active' : 'Backend: drive linked';
    fg = '#a8c8f8';
    bg = 'var(--accent-dim)';
    border = 'var(--accent)';
  } else if (storageMeta.preferredBackend === 'file' && storageMeta.localFileName) {
    label = 'Backend: file last used';
    fg = 'var(--text1)';
  } else if (storageMeta.preferredBackend === 'drive') {
    label = 'Backend: drive selected';
    fg = 'var(--amber)';
    bg = 'var(--amber-dim)';
    border = '#7a5a20';
  }

  el.textContent = label;
  el.style.color = fg;
  el.style.background = bg;
  el.style.borderColor = border;

  // Mirror to the Import tab status row (strips the "Backend: " prefix for cleaner look)
  const el2 = document.getElementById('backendBadge2');
  if (el2) {
    el2.textContent = label.replace('Backend: ', '') || '—';
    el2.style.color = fg;
  }
}

function waitForGoogleGlobals() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (window.gapi && window.google && window.google.accounts) {
        clearInterval(iv);
        resolve();
        return;
      }
      if (Date.now() - started > 15000) {
        clearInterval(iv);
        reject(new Error('Google API scripts did not load.'));
      }
    }, 100);
  });
}

async function ensureGoogleDriveReady() {
  if (gapiClientReady) return;

  if (window.location.protocol === 'file:') {
    throw new Error('Google Drive sync requires http://localhost or https:// (file:// is not supported by Google OAuth).');
  }

  if (!appConfig) {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Missing config.json with client_id');
    appConfig = await res.json();
  }
  if (!appConfig.client_id) throw new Error('config.json is missing client_id');

  await waitForGoogleGlobals();
  await new Promise((resolve, reject) => {
    window.gapi.load('client', {
      callback: resolve,
      onerror: () => reject(new Error('Failed to initialize gapi client')),
    });
  });

  await window.gapi.client.init({ discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'] });
  gapiClientReady = true;
}

function mapDriveAuthError(code) {
  if (!code) return 'Unknown authentication error';
  if (code === 'popup_closed_by_user') return 'Sign-in popup was closed before completion';
  if (code === 'popup_failed_to_open') return 'Browser blocked the sign-in popup — allow popups for this site';
  if (code === 'access_denied') return 'Google account access was denied';
  if (code === 'redirect_uri_mismatch') return 'Add auth-redirect.html to Authorized Redirect URIs in Google Cloud Console';
  return String(code);
}

async function requestDriveToken(prompt) {
  await ensureGoogleDriveReady();
  // Build the redirect URI pointing to our same-origin relay page.
  const redirectUri = window.location.href.replace(/[^/]*$/, '') + 'auth-redirect.html';
  const params = new URLSearchParams({
    client_id: appConfig.client_id,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: DRIVE_SCOPE,
    include_granted_scopes: 'true',
  });
  if (prompt) params.set('prompt', prompt);
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();

  return new Promise((resolve, reject) => {
    const popup = window.open(authUrl, 'driveAuth', 'width=520,height=640,left=200,top=80');
    if (!popup) {
      reject(new Error('Browser blocked the sign-in popup — allow popups for this site and try again'));
      return;
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      try { popup.close(); } catch {}
      reject(new Error('Drive sign-in timed out — did you complete the Google sign-in in the popup?'));
    }, 120000);
    function onMessage(evt) {
      if (evt.origin !== window.location.origin) return;
      if (!evt.data || evt.data.type !== 'TGC_OAUTH') return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      try { popup.close(); } catch {}
      if (evt.data.error) {
        reject(new Error(mapDriveAuthError(evt.data.error)));
        return;
      }
      if (!evt.data.token) {
        reject(new Error('No access token received from Google'));
        return;
      }
      driveAccessToken = evt.data.token;
      window.gapi.client.setToken({ access_token: driveAccessToken });
      resolve(driveAccessToken);
    }
    window.addEventListener('message', onMessage);
  });
}

async function driveFetch(url, options = {}) {
  if (!driveAccessToken) throw new Error('Google Drive is not authenticated');
  const headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + driveAccessToken });
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    throw new Error('Drive API error ' + res.status + (detail ? ' ' + detail : ''));
  }
  return res;
}

async function findDriveDataFile() {
  const q = `name='${DRIVE_DATA_FILE_NAME}' and trashed=false`;
  const resp = await window.gapi.client.drive.files.list({
    spaces: 'appDataFolder',
    pageSize: 10,
    fields: 'files(id,name,modifiedTime)',
    q,
  });
  const files = resp.result.files || [];
  return files[0] || null;
}

async function createDriveDataFile(contentObj) {
  const boundary = 'tgcapital_boundary_' + Date.now();
  const body =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name: DRIVE_DATA_FILE_NAME, parents: ['appDataFolder'] }) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(contentObj, null, 2) + '\r\n' +
    '--' + boundary + '--';

  const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body,
  });
  return res.json();
}

async function uploadDriveData(fileId, contentObj) {
  const boundary = 'tgcapital_boundary_' + Date.now();
  const body =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name: DRIVE_DATA_FILE_NAME }) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(contentObj, null, 2) + '\r\n' +
    '--' + boundary + '--';

  await driveFetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?uploadType=multipart&fields=id,name', {
    method: 'PATCH',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body,
  });
}

async function downloadDriveData(fileId) {
  const res = await driveFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media');
  return res.json();
}

async function connectGoogleDrive() {
  if (storageMeta.localDiskMode === true) {
    setFsStatus('Local Disk Mode is ON. Disable it to use Google Drive.', 'var(--amber)');
    return;
  }
  try {
    await requestDriveToken('consent');
    let file = await findDriveDataFile();
    if (!file) file = await createDriveDataFile(sanitizeDB(db));

    storageMeta.preferredBackend = 'drive';
    storageMeta.driveFileId = file.id;
    storageMeta.driveFileName = file.name;
    saveStorageMeta();

    const remote = await downloadDriveData(file.id);
    db = mergeDatabases(db, remote);
    await uploadDriveData(file.id, db);
    unsaved = false;
    setFsStatus('✓ Drive linked: ' + (file.name || DRIVE_DATA_FILE_NAME), 'var(--green)');
    refreshAll();
    addLog('Google Drive linked and synced (' + db.transactions.length + ' records)', 'ok');
  } catch (err) {
    setFsStatus('! Drive link failed: ' + err.message, 'var(--red)');
  }
}

async function syncToGoogleDrive(mode) {
  if (storageMeta.localDiskMode === true) {
    if (mode !== 'auto') setFsStatus('Local Disk Mode is ON. Drive save is disabled.', 'var(--amber)');
    return;
  }
  try {
    if (!storageMeta.driveFileId) {
      await connectGoogleDrive();
      return;
    }
    await requestDriveToken('');
    saveLocalBackup();
    await createDriveBackup();
    await uploadDriveData(storageMeta.driveFileId, sanitizeDB(db));
    unsaved = false;
    if (mode !== 'auto') setFsStatus('✓ Saved to Drive — ' + new Date().toLocaleTimeString(), 'var(--green)');
  } catch (err) {
    setFsStatus('! Drive save failed: ' + err.message, 'var(--red)');
  }
}

async function syncFromGoogleDrive() {
  if (storageMeta.localDiskMode === true) {
    setFsStatus('Local Disk Mode is ON. Drive restore is disabled.', 'var(--amber)');
    return;
  }
  try {
    await requestDriveToken('');
    if (!storageMeta.driveFileId) {
      const file = await findDriveDataFile();
      if (!file) {
        setFsStatus('No Drive data file found yet. Connect Drive first.', 'var(--amber)');
        return;
      }
      storageMeta.driveFileId = file.id;
      storageMeta.driveFileName = file.name;
      storageMeta.preferredBackend = 'drive';
      saveStorageMeta();
    }

    const remote = await downloadDriveData(storageMeta.driveFileId);
    db = mergeDatabases(db, remote);
    unsaved = false;
    setFsStatus('✓ Synced from Drive — ' + new Date().toLocaleTimeString(), 'var(--green)');
    refreshAll();
  } catch (err) {
    setFsStatus('! Drive sync failed: ' + err.message, 'var(--red)');
  }
}

let driveBootPromptShown = false;

async function maybeAutoConnectDriveOnLoad() {
  if (driveBootPromptShown) return;
  if (storageMeta.localDiskMode === true) return;
  if (!(storageMeta.preferredBackend === 'drive' || storageMeta.driveFileId)) return;
  driveBootPromptShown = true;

  if (storageMeta.autoDriveConnect !== false) {
    if (storageMeta.driveFileId) {
      await syncFromGoogleDrive();
      setFsStatus('✓ Drive connected and restored — auto-save to Drive is active', 'var(--green)');
      return;
    }
    await connectGoogleDrive();
    setFsStatus('✓ Drive connected — auto-save to Drive is active', 'var(--green)');
    return;
  }

  const shouldConnect = window.confirm(
    'Connect to Google Drive now and restore your latest dashboard data?\n\n'
    + 'Choose OK to sign in and auto-load your data.\n'
    + 'Choose Cancel to stay local for now.'
  );
  if (!shouldConnect) {
    setFsStatus('Drive linked — click ☁ Connect Drive or ☁↓ Restore from Drive when ready.', 'var(--amber)');
    return;
  }

  if (storageMeta.driveFileId) {
    await syncFromGoogleDrive();
    setFsStatus('✓ Drive connected and restored — auto-save to Drive is active', 'var(--green)');
    return;
  }

  await connectGoogleDrive();
  setFsStatus('✓ Drive connected — auto-save to Drive is active', 'var(--green)');
}

// ── Warn on unsaved close ────────────────────────────────
window.addEventListener('beforeunload', e => {
  if (unsaved) { e.preventDefault(); e.returnValue = ''; }
});

// ════════════════════════════════════════════════════════
// BACKUP — Drive snapshots + localStorage
// ════════════════════════════════════════════════════════
const DRIVE_BACKUP_PREFIX = 'tgcapital-backup-';
const MAX_DRIVE_BACKUPS = 7;
const MAX_LOCAL_BACKUPS = 5;
const LOCAL_BACKUP_KEY = 'tgcapital_backups_v1';

function saveLocalBackup() {
  try {
    const entry = {
      ts: new Date().toISOString(),
      n: db.transactions?.length || 0,
      d: JSON.stringify(sanitizeDB(db)),
    };
    let backups = [];
    try { backups = JSON.parse(localStorage.getItem(LOCAL_BACKUP_KEY) || '[]'); } catch {}
    backups.unshift(entry);
    if (backups.length > MAX_LOCAL_BACKUPS) backups.length = MAX_LOCAL_BACKUPS;
    try {
      localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(backups));
    } catch {
      // If storage is full, try keeping just the newest one
      try { localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify([entry])); } catch {}
    }
  } catch (err) {
    console.warn('Local backup failed:', err.message);
  }
}

function getLocalBackups() {
  try { return JSON.parse(localStorage.getItem(LOCAL_BACKUP_KEY) || '[]'); } catch { return []; }
}

async function createDriveBackup() {
  if (!storageMeta.driveFileId) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = DRIVE_BACKUP_PREFIX + ts + '.json';
    const boundary = 'tgcap_bkp_' + Date.now();
    const body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name, parents: ['appDataFolder'] }) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(sanitizeDB(db)) + '\r\n' +
      '--' + boundary + '--';
    await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
      body,
    });
    pruneOldDriveBackups();
  } catch (err) {
    console.warn('Drive backup failed:', err.message);
  }
}

async function listDriveBackups() {
  const resp = await window.gapi.client.drive.files.list({
    spaces: 'appDataFolder',
    pageSize: 20,
    fields: 'files(id,name,modifiedTime)',
    q: `name contains '${DRIVE_BACKUP_PREFIX}' and trashed=false`,
    orderBy: 'modifiedTime desc',
  });
  return resp.result.files || [];
}

async function pruneOldDriveBackups() {
  try {
    const backups = await listDriveBackups();
    const toDelete = backups.slice(MAX_DRIVE_BACKUPS);
    for (const f of toDelete) {
      try {
        await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      } catch {}
    }
  } catch {}
}

async function showDriveHistory() {
  const modal = document.getElementById('backupModal');
  const body  = document.getElementById('backupModalBody');
  modal.style.display = 'flex';
  body.innerHTML = '<div style="color:var(--text2);padding:24px 0;text-align:center;">Loading…</div>';

  let driveRows = '';
  const localBackups = getLocalBackups();

  // Drive backups
  if (storageMeta.driveFileId && driveAccessToken) {
    try {
      const files = await listDriveBackups();
      if (files.length) {
        driveRows = files.map((f, i) => {
          const dt = new Date(f.modifiedTime).toLocaleString();
          // Parse txn count from name if embedded, else show date
          return `<tr>
            <td style="padding:6px 8px;font-family:var(--mono);font-size:11px;">${dt}</td>
            <td style="padding:6px 8px;color:var(--text2);font-size:11px;">Drive snapshot</td>
            <td style="padding:6px 8px;text-align:right;">
              <button class="btn btn-sm" onclick="restoreDriveBackup('${f.id}')" style="background:var(--accent);color:#fff;border:none;font-size:11px;">Restore</button>
            </td>
          </tr>`;
        }).join('');
      } else {
        driveRows = `<tr><td colspan="3" style="padding:12px;color:var(--text2);font-size:11px;">No Drive snapshots found yet.</td></tr>`;
      }
    } catch (err) {
      driveRows = `<tr><td colspan="3" style="padding:12px;color:var(--red);font-size:11px;">Could not load Drive backups: ${err.message}</td></tr>`;
    }
  } else {
    driveRows = `<tr><td colspan="3" style="padding:12px;color:var(--text2);font-size:11px;">Connect Drive to see cloud snapshots.</td></tr>`;
  }

  const localRows = localBackups.length
    ? localBackups.map((b, i) => {
        const dt = new Date(b.ts).toLocaleString();
        return `<tr>
          <td style="padding:6px 8px;font-family:var(--mono);font-size:11px;">${dt}</td>
          <td style="padding:6px 8px;color:var(--text2);font-size:11px;">Local — ${b.n} transactions</td>
          <td style="padding:6px 8px;text-align:right;">
            <button class="btn btn-sm" onclick="restoreLocalBackup(${i})" style="background:var(--bg3);color:var(--text1);border:1px solid var(--border);font-size:11px;">Restore</button>
          </td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="3" style="padding:12px;color:var(--text2);font-size:11px;">No local snapshots yet — they appear after your first save.</td></tr>`;

  body.innerHTML = `
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text2);margin-bottom:6px;font-family:var(--mono);">Drive Snapshots (last ${MAX_DRIVE_BACKUPS})</div>
      <table style="width:100%;border-collapse:collapse;">${driveRows}</table>
    </div>
    <div>
      <div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text2);margin-bottom:6px;font-family:var(--mono);">Local Snapshots (last ${MAX_LOCAL_BACKUPS})</div>
      <table style="width:100%;border-collapse:collapse;">${localRows}</table>
    </div>`;
}

function closeBackupModal() {
  document.getElementById('backupModal').style.display = 'none';
}

async function restoreDriveBackup(fileId) {
  if (!confirm('Restore this Drive snapshot? Your current data will be replaced.')) return;
  try {
    const res  = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    const data = await res.json();
    db = sanitizeDB(data);
    saveDB(db);
    refreshAll();
    closeBackupModal();
    setFsStatus('✓ Snapshot restored — ' + new Date().toLocaleTimeString(), 'var(--green)');
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
}

function restoreLocalBackup(index) {
  const backups = getLocalBackups();
  const entry = backups[index];
  if (!entry) return;
  if (!confirm(`Restore local snapshot from ${new Date(entry.ts).toLocaleString()} (${entry.n} transactions)?`)) return;
  try {
    db = sanitizeDB(JSON.parse(entry.d));
    saveDB(db);
    refreshAll();
    closeBackupModal();
    setFsStatus('✓ Local snapshot restored — ' + new Date().toLocaleTimeString(), 'var(--green)');
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
}
