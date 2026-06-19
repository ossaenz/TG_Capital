// ════════════════════════════════════════════════════════
// POSITION ENGINE  — full open-leg preservation + fee attribution
// ════════════════════════════════════════════════════════

function buildPositions() {
  // Opens must always sort before closes on the same date
  const ACTION_ORDER = {
    'Sell to Open': 0, 'Buy to Open': 0, 'Buy': 0,
    'Buy to Close': 1, 'Sell to Close': 1, 'Expired': 1, 'Assigned': 1, 'Exercised': 1, 'Sell': 1,
  };
  const sorted = [...db.transactions].sort((a, b) => {
    const dateA = a.date || a.rawDate, dateB = b.date || b.rawDate;
    const dateCmp = dateA.localeCompare(dateB);
    if (dateCmp !== 0) return dateCmp;
    return (ACTION_ORDER[a.action] ?? 2) - (ACTION_ORDER[b.action] ?? 2);
  });

  const openLots  = {};  // optionSymbol → [{txn, qty, openAmount, openFees, openPrice}]
  const stockLots = {};  // ticker       → [{txn, qty, costBasis, openFees, openPrice}]
  const closedTrades = [];

  for (const t of sorted) {
    const isOption = t.instrument === 'option';

    // ── OPTION OPENS ──────────────────────────────────────
    if (['Sell to Open', 'Buy to Open'].includes(t.action) && isOption) {
      const k = t.symbol;
      if (!openLots[k]) openLots[k] = [];
      openLots[k].push({
        txn:        t,
        qty:        t.quantity || 0,
        openAmount: t.amount   || 0,
        openFees:   t.fees     || 0,
        openPrice:  t.price    || 0,   // per-contract price e.g. $1.96
      });
    }

    // ── OPTION CLOSES (BTC / STC) ─────────────────────────
    else if (['Buy to Close', 'Sell to Close'].includes(t.action) && isOption) {
      const k = t.symbol;
      const lots = openLots[k] || [];
      let remaining = Math.abs(t.quantity || 0);
      let openCredit = 0, openFeesAlloc = 0, openDateFirst = null, openPriceWtd = 0, matchedTotal = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot     = lots[0];
        const matched = Math.min(lot.qty, remaining);
        const frac    = matched / lot.qty;
        openCredit   += (lot.openAmount / lot.qty) * matched;
        openFeesAlloc+= lot.openFees * frac;
        openPriceWtd += lot.openPrice * matched;
        matchedTotal += matched;
        if (!openDateFirst) openDateFirst = lot.txn.date;
        lot.qty      -= matched;
        lot.openFees -= lot.openFees * frac;
        remaining    -= matched;
        if (lot.qty <= 0) lots.shift();
      }

      const avgOpenPrice = matchedTotal > 0 ? openPriceWtd / matchedTotal : 0;
      // grossPnl = openCredit + closeAmount. Both figures from Schwab's Amount column,
      // which is already net of fees — so grossPnl IS the net P&L. fees is tracked
      // separately for display/reporting but must NOT be subtracted again.
      const grossPnl = openCredit + (t.amount || 0);
      const totalFees = openFeesAlloc + (t.fees || 0);

      closedTrades.push({
        symbol: t.symbol, underlying: t.underlying,
        instrument: 'option', optionType: t.optionType,
        strike: t.strike, expiry: t.expiry,
        openDate: openDateFirst, closeDate: t.date,
        qty: matchedTotal,
        openPrice: avgOpenPrice,          // $/contract when sold to open
        openCredit,                        // total net credit received on open
        openFees: openFeesAlloc,
        closePrice: t.price || 0,         // $/contract when bought to close
        closeCost: t.amount || 0,          // total net debit paid on close
        closeFees: t.fees || 0,
        grossPnl, fees: totalFees,
        netPnl: grossPnl,                  // Amount is already net of fees — no double-subtract
        via: 'closed', closeAction: t.action, closeTxn: t,
      });
    }

    // ── EXPIRED WORTHLESS ─────────────────────────────────
    else if (t.action === 'Expired' && isOption) {
      const k = t.symbol;
      const lots = openLots[k] || [];
      let remaining = Math.abs(t.quantity || 1);
      let openCredit = 0, openFeesAlloc = 0, openDateFirst = null, openPriceWtd = 0, matchedTotal = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot     = lots[0];
        const matched = Math.min(lot.qty, remaining);
        const frac    = matched / lot.qty;
        openCredit   += (lot.openAmount / lot.qty) * matched;
        openFeesAlloc+= lot.openFees * frac;
        openPriceWtd += lot.openPrice * matched;
        matchedTotal += matched;
        if (!openDateFirst) openDateFirst = lot.txn.date;
        lot.qty      -= matched;
        lot.openFees -= lot.openFees * frac;
        remaining    -= matched;
        if (lot.qty <= 0) lots.shift();
      }

      const avgOpenPrice = matchedTotal > 0 ? openPriceWtd / matchedTotal : 0;
      const grossPnl = openCredit;
      const totalFees = openFeesAlloc;

      closedTrades.push({
        symbol: t.symbol, underlying: t.underlying,
        instrument: 'option', optionType: t.optionType,
        strike: t.strike, expiry: t.expiry,
        openDate: openDateFirst, closeDate: t.date,
        qty: matchedTotal,
        openPrice: avgOpenPrice,
        openCredit, openFees: openFeesAlloc,
        closePrice: 0,
        closeCost: 0, closeFees: 0,
        grossPnl, fees: totalFees,
        netPnl: grossPnl,                  // Amount already net of fees
        via: 'expired', closeAction: 'Expired', closeTxn: t,
      });
    }

    // ── ASSIGNED ──────────────────────────────────────────
    else if (t.action === 'Assigned' && isOption) {
      const k = t.symbol;
      const lots = openLots[k] || [];
      let remaining = Math.abs(t.quantity || 1);
      let openCredit = 0, openFeesAlloc = 0, openDateFirst = null, openPriceWtd = 0, matchedTotal = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot     = lots[0];
        const matched = Math.min(lot.qty, remaining);
        const frac    = matched / lot.qty;
        openCredit   += (lot.openAmount / lot.qty) * matched;
        openFeesAlloc+= lot.openFees * frac;
        openPriceWtd += lot.openPrice * matched;
        matchedTotal += matched;
        if (!openDateFirst) openDateFirst = lot.txn.date;
        lot.qty      -= matched;
        lot.openFees -= lot.openFees * frac;
        remaining    -= matched;
        if (lot.qty <= 0) lots.shift();
      }

      const avgOpenPrice = matchedTotal > 0 ? openPriceWtd / matchedTotal : 0;
      const grossPnl = openCredit;
      const totalFees = openFeesAlloc;

      closedTrades.push({
        symbol: t.symbol, underlying: t.underlying,
        instrument: 'option', optionType: t.optionType,
        strike: t.strike, expiry: t.expiry,
        openDate: openDateFirst, closeDate: t.date,
        qty: matchedTotal,
        openPrice: avgOpenPrice,
        openCredit, openFees: openFeesAlloc,
        closePrice: t.strike || 0,
        closeCost: 0, closeFees: 0,
        grossPnl, fees: totalFees,
        netPnl: grossPnl,                  // Amount already net of fees
        via: t.optionType === 'call' ? 'exercised' : 'assigned', closeAction: 'Assigned', closeTxn: t,
      });
    }

    // ── EXERCISED (covered call called away) ─────────────
    // Schwab may use the underlying ticker as the symbol for Exercised rows
    // instead of the full option symbol. Try direct key first, then search
    // open lots for a short call whose underlying matches the ticker.
    else if (t.action === 'Exercised') {
      let lots = openLots[t.symbol] || [];
      let refTxn = t; // source of option details (strike, expiry, optionType)

      if (!lots.length) {
        const underlying = t.underlying || t.symbol;
        const matchKey = Object.keys(openLots).find(k => {
          const info = parseOptionSymbol(k);
          return info && info.underlying === underlying && openLots[k].length > 0
            && openLots[k].some(l => l.txn.optionType === 'call');
        });
        if (matchKey) { lots = openLots[matchKey]; refTxn = lots[0].txn; }
      }

      let remaining = Math.abs(t.quantity || 1);
      let openCredit = 0, openFeesAlloc = 0, openDateFirst = null, openPriceWtd = 0, matchedTotal = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot     = lots[0];
        const matched = Math.min(lot.qty, remaining);
        const frac    = matched / lot.qty;
        openCredit   += (lot.openAmount / lot.qty) * matched;
        openFeesAlloc+= lot.openFees * frac;
        openPriceWtd += lot.openPrice * matched;
        matchedTotal += matched;
        if (!openDateFirst) openDateFirst = lot.txn.date;
        lot.qty      -= matched;
        lot.openFees -= lot.openFees * frac;
        remaining    -= matched;
        if (lot.qty <= 0) lots.shift();
      }

      if (matchedTotal <= 0) continue; // no matching open lot — skip (carry-in position)

      const avgOpenPrice = matchedTotal > 0 ? openPriceWtd / matchedTotal : 0;

      closedTrades.push({
        symbol: refTxn.symbol, underlying: refTxn.underlying || t.symbol,
        instrument: 'option', optionType: refTxn.optionType,
        strike: refTxn.strike, expiry: refTxn.expiry,
        openDate: openDateFirst, closeDate: t.date,
        qty: matchedTotal,
        openPrice: avgOpenPrice,
        openCredit, openFees: openFeesAlloc,
        closePrice: refTxn.strike || 0,
        closeCost: 0, closeFees: 0,
        grossPnl: openCredit, fees: openFeesAlloc,
        netPnl: openCredit,
        via: 'exercised', closeAction: 'Exercised', closeTxn: t,
      });
    }

    // ── STOCK BUY ─────────────────────────────────────────
    else if (t.action === 'Buy' && !isOption) {
      const k = t.symbol;
      if (!stockLots[k]) stockLots[k] = [];
      stockLots[k].push({
        txn: t, qty: t.quantity || 0,
        costBasis: Math.abs(t.amount || 0),
        openFees: t.fees || 0,
        openPrice: t.price || 0,
      });
    }

    // ── STOCK SELL ────────────────────────────────────────
    else if (t.action === 'Sell' && !isOption) {
      const k = t.symbol;
      if (!stockLots[k]) stockLots[k] = [];
      // Same-date lots are consumed first so intraday buy+sell pairs (day trades)
      // cancel each other without touching pre-existing older lots. Remaining
      // quantity then falls through to standard FIFO against older lots.
      const sellDate = t.date;
      const lots = [
        ...stockLots[k].filter(l => l.txn.date === sellDate),
        ...stockLots[k].filter(l => l.txn.date !== sellDate),
      ];
      stockLots[k] = lots;
      let remaining = Math.abs(t.quantity || 0);
      let totalCost = 0, openFeesAlloc = 0, openDateFirst = null, openPriceWtd = 0, matchedTotal = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot          = lots[0];
        const matched      = Math.min(lot.qty, remaining);
        const frac         = matched / lot.qty;
        const perShareCost = lot.costBasis / lot.qty;
        totalCost    += perShareCost * matched;
        openFeesAlloc+= lot.openFees * frac;
        openPriceWtd += lot.openPrice * matched;
        matchedTotal += matched;
        if (!openDateFirst) openDateFirst = lot.txn.date;
        lot.costBasis -= perShareCost * matched; // keep remaining cost basis accurate
        lot.qty       -= matched;
        lot.openFees  -= lot.openFees * frac;
        remaining     -= matched;
        if (lot.qty <= 0) lots.shift();
      }

      // Only record stock P&L if we have a matched buy lot.
      // Skip if unmatched (carry-in holdings from before loaded data).
      if (matchedTotal <= 0) {
        console.log(`SKIP unmatched: ${t.symbol} sell on ${t.date} qty=${t.quantity}`);
        continue;
      }

      const avgOpenPrice = matchedTotal > 0 ? openPriceWtd / matchedTotal : 0;
      const sellQty = Math.abs(t.quantity || 0) || matchedTotal;
      const matchedFrac = Math.min(1, matchedTotal / sellQty);
      const proceeds = Math.abs(t.amount || 0) * matchedFrac;
      const closeFeesAlloc = (t.fees || 0) * matchedFrac;
      const grossPnl  = proceeds - totalCost;
      const totalFees = openFeesAlloc + closeFeesAlloc;

      closedTrades.push({
        symbol: t.symbol, underlying: t.symbol,
        instrument: ETF_LIST.has(t.symbol) ? 'etf' : 'stock',
        optionType: null, strike: null, expiry: null,
        openDate: openDateFirst, closeDate: t.date,
        qty: matchedTotal,
        openPrice: avgOpenPrice,
        openCredit: -totalCost,
        openFees: openFeesAlloc,
        closePrice: t.price || 0,
        closeCost: proceeds, closeFees: closeFeesAlloc,
        grossPnl, fees: totalFees,
        netPnl: grossPnl,                  // Amount already net of fees
        via: 'sold', closeAction: 'Sell', closeTxn: t,
      });
    }
  }

  // ── BUILD OPEN POSITIONS ──────────────────────────────
  const openPositions = [];

  for (const [sym, lots] of Object.entries(openLots)) {
    for (const lot of lots) {
      if (lot.qty <= 0) continue;
      const t = lot.txn;
      openPositions.push({
        symbol: sym, underlying: t.underlying,
        instrument: 'option', optionType: t.optionType,
        direction: t.direction, qty: lot.qty,
        openDate: t.date, expiry: t.expiry, strike: t.strike,
        openPrice: lot.openPrice,
        avgCost: lot.openAmount / lot.txn.quantity,
        premiumRcvd: t.direction === 'short' ? Math.abs(lot.openAmount) : 0,
        openFees: lot.openFees, status: 'open',
      });
    }
  }

  for (const [sym, lots] of Object.entries(stockLots)) {
    for (const lot of lots) {
      if (lot.qty <= 0) continue;
      openPositions.push({
        symbol: sym, underlying: sym,
        instrument: ETF_LIST.has(sym) ? 'etf' : 'stock',
        optionType: null, direction: 'long', qty: lot.qty,
        openDate: lot.txn.date, expiry: null, strike: null,
        openPrice: lot.openPrice,
        avgCost: lot.qty > 0 ? lot.costBasis / lot.qty : 0,
        premiumRcvd: 0, openFees: lot.openFees, status: 'open',
      });
    }
  }

  return { openPositions, closedTrades };
}

// ════════════════════════════════════════════════════════
// WASH SALE DETECTION
// ════════════════════════════════════════════════════════
function detectWashSales(txnsToCheck) {
  // If no txns provided, use all transactions
  const txns = txnsToCheck || db.transactions;
  const sorted = [...txns].sort((a, b) => (a.date || a.rawDate).localeCompare(b.date || b.rawDate));
  const flags = [];
  const seenPairs = new Set();  // Dedupe by (underlying, lossDate)

  // Collect loss events (BTC where amount < 0 AND more than premium received, or Sell stock at loss)
  const losses = sorted.filter(t => {
    if (!t.date) return false;
    if (['Buy to Close'].includes(t.action)) {
      // It's a loss if the cost to close > 0 (net negative P&L on the round-trip)
      // Simple heuristic: BTC amount is negative (we paid to close)
      return (t.amount || 0) < -1;
    }
    if (t.action === 'Sell' && t.instrument !== 'option') {
      return (t.amount || 0) < 0;
    }
    return false;
  });

  // For each loss, look for repurchase of substantially identical security within 30 days before or after
  for (const loss of losses) {
    const lossDate = new Date(loss.date);
    const lossUnderlying = loss.underlying || loss.symbol;

    // Find repurchases (STO or Buy of same underlying) within 30 days
    const repurchases = sorted.filter(t => {
      if (!t.date || t.id === loss.id) return false;
      const tDate = new Date(t.date);
      const diff = Math.abs((tDate - lossDate) / 86400000);
      if (diff > 30) return false;
      const tUnderlying = t.underlying || t.symbol;
      if (tUnderlying !== lossUnderlying) return false;
      // Must be an opening or buy transaction
      return ['Sell to Open', 'Buy', 'Buy to Open'].includes(t.action);
    });

    for (const rep of repurchases) {
      const days = Math.round(Math.abs((new Date(rep.date) - lossDate) / 86400000));
      const pairKey = `${lossUnderlying}|${loss.date}`;
      if (seenPairs.has(pairKey)) continue;  // Skip duplicate loss-underlying pairs
      seenPairs.add(pairKey);
      
      flags.push({
        symbol: lossUnderlying,
        lossDate: loss.date,
        lossAmount: loss.amount,
        repDate: rep.date,
        daysApart: days,
        repAction: rep.action,
        risk: days <= 7 ? 'HIGH' : days <= 14 ? 'MEDIUM' : 'LOW',
        lossTxn: loss,
        repTxn: rep,
      });
    }
  }

  return flags;
}
