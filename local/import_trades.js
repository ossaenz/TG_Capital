const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = './data/trades.db';
const db = new Database(dbPath);

const jsonFile = '/home/osaenz/Downloads/Designated_Bene_Individual_XXX122_Transactions_20260823-180754.json';
const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

const stmt = db.prepare(`
  INSERT OR IGNORE INTO trades (date_iso, action, symbol, description, quantity, price, fees, amount, asset_type, underlying)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let inserted = 0;
for (const t of data.BrokerageTransactions) {
  const dateStr = t.Date;
  const [m, d, y] = dateStr.split('/');
  const iso = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  
  const qty = t.Quantity ? parseFloat(t.Quantity) : null;
  const price = t.Price ? parseFloat(t.Price.replace('$','')) : null;
  const fees = t['Fees & Comm'] ? parseFloat(t['Fees & Comm'].replace('$','')) : 0;
  const amount = t.Amount ? parseFloat(t.Amount.replace('$','')) : 0;
  
  let assetType = 'EQUITY';
  let underlying = t.Symbol;
  if (t.Symbol.includes(' ') && /[CP]$/.test(t.Symbol)) {
    assetType = 'OPTION';
    underlying = t.Symbol.split(' ')[0];
  }
  
  const result = stmt.run(iso, t.Action, t.Symbol, t.Description, qty, price, fees, amount, assetType, underlying);
  if (result.changes) inserted++;
}

console.log(`Imported ${inserted} trades`);
db.close();
