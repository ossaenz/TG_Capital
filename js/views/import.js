function renderImportHistory() {
  const tbody = document.querySelector('#importHistTable tbody');
  if (db.importBatches.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No imports yet.</td></tr>';
    return;
  }
  tbody.innerHTML = [...db.importBatches].reverse().map(b => `<tr>
    <td style="color:var(--text2)">${new Date(b.importedAt).toLocaleString()}</td>
    <td><span style="font-family:var(--mono)">${b.fileName}</span></td>
    <td class="r">${b.total}</td>
    <td class="r"><span class="pos g">+${b.added}</span></td>
    <td class="r"><span style="color:var(--text2)">${b.dupes}</span></td>
    <td></td>
  </tr>`).join('');
}


// ════════════════════════════════════════════════════════
// FILE IMPORT
// ════════════════════════════════════════════════════════
function handleDrop(ev) {
  ev.preventDefault();
  document.getElementById('dropZone').classList.remove('drag');
  const files = Array.from(ev.dataTransfer.files);
  if (files.length > 0) processBatch(files);
}

function handleFileSelect(ev) {
  const files = Array.from(ev.target.files);
  if (files.length > 0) processBatch(files);
  ev.target.value = '';
}

function processBatch(files) {
  const log = document.getElementById('importLog');
  log.innerHTML = '';
  log.style.display = 'block';
  
  addLog(`[${new Date().toLocaleTimeString()}] Starting batch import: ${files.length} file(s)`, 'info');
  
  let totalAdded = 0, totalDupes = 0, totalRows = 0;
  
  // Process files sequentially
  const processNext = (index) => {
    if (index >= files.length) {
      // All files processed
      addLog(``, '');
      addLog(`Batch complete!`, 'ok');
      addLog(`Total: ${totalRows} rows, ${totalAdded} imported, ${totalDupes} dupes skipped`, 'ok');
      addLog(`Database now has: ${db.transactions.length} transactions`, 'info');
      if (fileHandle) {
        addLog('Auto-saving to ' + fileHandle.name + '…', 'info');
      } else if (storageMeta.driveFileId) {
        addLog('Auto-saving to Google Drive…', 'info');
      }
      refreshAll();
      addLog('All views refreshed.', 'ok');
      return;
    }
    
    const file = files[index];
    // Each file gets its own unique batchId
    const fileBatchId = 'batch_' + Date.now() + '_' + index;
    processFileForBatch(file, fileBatchId, (added, dupes, rows) => {
      totalAdded += added;
      totalDupes += dupes;
      totalRows += rows;
      processNext(index + 1);
    });
  };
  
  processNext(0);
}

function processFileForBatch(file, parentBatchId, callback) {
  addLog(`Processing: ${file.name}`, 'info');
  
  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    let rawRows = [];
    try {
      if (file.name.endsWith('.json')) {
        const data = JSON.parse(content);
        rawRows = data.BrokerageTransactions || (Array.isArray(data) ? data : []);
        addLog(`  ✓ JSON: ${rawRows.length} transactions`, 'ok');
      } else {
        rawRows = normalizeImportedCsvRows(file.name, parseCSV(content));
        addLog(`  ✓ CSV: ${rawRows.length} rows`, 'ok');
      }
    } catch (err) {
      addLog(`  ✗ Parse error: ${err.message}`, 'err');
      callback(0, 0, 0);
      return;
    }
    
    const { added, dupes, total } = importRecords(rawRows, file.name, parentBatchId);
    addLog(`  → ${added} new, ${dupes} dupes skipped`, added > 0 ? 'ok' : 'warn');
    callback(added, dupes, total);
  };
  
  reader.onerror = () => {
    addLog(`  ✗ Failed to read file`, 'err');
    callback(0, 0, 0);
  };
  
  reader.readAsText(file);
}

function addLog(msg, cls = '') {
  const log = document.getElementById('importLog');
  log.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'log-line ' + cls;
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function processFile(file) {
  const log = document.getElementById('importLog');
  log.innerHTML = '';
  const batchId = 'batch_' + Date.now();
  addLog(`[${new Date().toLocaleTimeString()}] Processing: ${file.name}`, 'info');

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    let rawRows = [];
    try {
      if (file.name.endsWith('.json')) {
        const data = JSON.parse(content);
        rawRows = data.BrokerageTransactions || (Array.isArray(data) ? data : []);
        addLog(`Parsed JSON: ${rawRows.length} transactions found`, 'ok');
      } else {
        rawRows = normalizeImportedCsvRows(file.name, parseCSV(content));
        addLog(`Parsed CSV: ${rawRows.length} rows found`, 'ok');
      }
    } catch (err) {
      addLog('Parse error: ' + err.message, 'err');
      return;
    }

    const { added, dupes, total } = importRecords(rawRows, file.name, batchId);
    addLog(`Imported: ${added} new records`, 'ok');
    if (dupes > 0) addLog(`Skipped: ${dupes} duplicate records`, 'warn');
    addLog(`Total in database: ${db.transactions.length}`, 'info');
    if (fileHandle) {
      addLog('Auto-saving to ' + fileHandle.name + '…', 'info');
    } else if (storageMeta.driveFileId) {
      addLog('Auto-saving to Google Drive…', 'info');
    } else {
      addLog('Tip: click ☁ Connect Drive to enable auto-sync backup, or click 💾 Save for a local file.', 'warn');
    }
    refreshAll();
    addLog('Done. All views refreshed.', 'ok');
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (!confirm('Clear ALL data? This cannot be undone.')) return;
  db = createEmptyDB();
  fileHandle = null;
  saveDB(db);
  refreshAll();
  document.getElementById('importLog').innerHTML = '';
  addLog('All data cleared. File link released — use 💾 Save to write a new file.', 'warn');
  setFsStatus('No file linked', 'var(--text2)');
}

function debugExportDB() {
  console.clear();
  console.log('%c=== DATABASE EXPORT ===', 'color: #ff6b6b; font-weight: bold; font-size: 16px');
  console.log('Total transactions:', db.transactions.length);
  console.log('Full DB:', JSON.parse(JSON.stringify(db)));
  const stocks = db.transactions.filter(t => !t.symbol || (t.symbol && !t.symbol.includes('C') && !t.symbol.includes('P')));
  console.log('Stock-like transactions:', stocks);
  alert('Database exported to console. Press F12 to view.');
}
