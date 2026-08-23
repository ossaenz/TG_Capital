/**
 * Stock Valuation — calculates intrinsic value using multiple methods
 */

/**
 * Graham Number: Simple intrinsic value formula
 * sqrt(22.5 * EPS * Book Value Per Share)
 * More conservative than DCF; good for value investing
 */
function calculateGrahamNumber(eps, bvps) {
  if (!eps || eps <= 0 || !bvps || bvps <= 0) return null;
  return Math.sqrt(22.5 * eps * bvps);
}

/**
 * PEG Ratio-based Fair Value
 * Fair Value = Current P/E * Growth Rate
 * If PEG < 1, stock is undervalued; > 2 is overvalued
 */
function calculateFairValueFromPEG(currentPrice, eps, earningsGrowthRate) {
  if (!eps || eps <= 0 || !earningsGrowthRate) return null;

  const currentPE = currentPrice / eps;
  const fairPE = Math.max(1, currentPE / Math.sqrt(earningsGrowthRate / 100));
  return eps * fairPE;
}

/**
 * DCF (Discounted Cash Flow) Valuation
 * Projects future free cash flows, calculates terminal value, and discounts to present
 */
function calculateDCFValue(fcf, growthRate = 12, terminalGrowth = 2.5, discountRate = 9, sharesOutstanding = 1, years = 5) {
  if (!fcf || fcf <= 0) return null;

  const gr = growthRate / 100;
  const tg = terminalGrowth / 100;
  const dr = discountRate / 100;

  // 1. Project future Free Cash Flows
  let projectedFcf = [];
  let currentFcf = fcf;
  for (let y = 1; y <= years; y++) {
    currentFcf *= (1 + gr);
    projectedFcf.push(currentFcf);
  }

  // 2. Calculate Terminal Value (Gordon Growth Model)
  const terminalValue = (projectedFcf[projectedFcf.length - 1] * (1 + tg)) / (dr - tg);

  // 3. Discount forecasted cash flows to Present Value
  let pvCashFlows = projectedFcf.map((cashFlow, index) => {
    const year = index + 1;
    return cashFlow / Math.pow((1 + dr), year);
  });

  // 4. Discount Terminal Value to Present Value
  const pvTerminalValue = terminalValue / Math.pow((1 + dr), years);

  // 5. Sum total equity value and divide by outstanding shares
  const totalIntrinsicValue = pvCashFlows.reduce((a, b) => a + b, 0) + pvTerminalValue;
  const valuePerShare = totalIntrinsicValue / sharesOutstanding;

  return valuePerShare;
}

/**
 * Price-to-Book based Fair Value
 * Median P/B for the industry or 1.5 for general equities
 */
function calculateFairValueFromPB(bookValuePerShare, targetPB = 1.5) {
  if (!bookValuePerShare || bookValuePerShare <= 0) return null;
  return bookValuePerShare * targetPB;
}

/**
 * Dividend Discount Model (Gordon Growth)
 * Fair Value = (Annual Dividend * (1 + growth)) / (discount - growth)
 */
function calculateDDMValue(annualDividend, growthRate = 5, discountRate = 10) {
  if (!annualDividend || annualDividend <= 0) return null;

  const gr = growthRate / 100;
  const dr = discountRate / 100;

  if (dr <= gr) return null; // Invalid assumption

  return (annualDividend * (1 + gr)) / (dr - gr);
}

/**
 * Aggregate intrinsic value from multiple methods
 * Returns estimated fair value + data quality assessment
 */
function calculateIntrinsicValue(metrics) {
  const {
    price,
    eps,
    bvps,
    dividend = 0,
    fcf,
    earningsGrowthRate = 15,
    sharesOutstanding = 1,
    marketCap = null,
    revenue = null,
    priceToBenefit = 15, // reasonable default P/E
  } = metrics;

  const valuations = [];
  const methods = [];

  // Method 1: Graham Number
  if (eps && bvps) {
    const graham = calculateGrahamNumber(eps, bvps);
    if (graham) {
      valuations.push(graham);
      methods.push({ name: 'Graham Number', value: Math.round(graham * 100) / 100, weight: 1 });
    }
  }

  // Method 2: P/E based (current earnings projected forward)
  if (eps && earningsGrowthRate) {
    const peValue = calculateFairValueFromPEG(price, eps, earningsGrowthRate);
    if (peValue) {
      valuations.push(peValue);
      methods.push({ name: 'PEG-adjusted P/E', value: Math.round(peValue * 100) / 100, weight: 0.9 });
    }
  }

  // Method 3: P/B based
  if (bvps) {
    const pbValue = calculateFairValueFromPB(bvps, 1.5);
    if (pbValue) {
      valuations.push(pbValue);
      methods.push({ name: 'Price-to-Book (1.5x)', value: Math.round(pbValue * 100) / 100, weight: 0.8 });
    }
  }

  // Method 4: Dividend Discount Model
  if (dividend > 0) {
    const ddmValue = calculateDDMValue(dividend, earningsGrowthRate, 10);
    if (ddmValue) {
      valuations.push(ddmValue);
      methods.push({ name: 'Dividend Discount Model', value: Math.round(ddmValue * 100) / 100, weight: 0.7 });
    }
  }

  // Method 5: Simple DCF
  if (fcf) {
    const dcfValue = calculateDCFValue(fcf, earningsGrowthRate, 3, 10, sharesOutstanding);
    if (dcfValue) {
      valuations.push(dcfValue);
      methods.push({ name: 'Free Cash Flow DCF', value: Math.round(dcfValue * 100) / 100, weight: 1.1 });
    }
  }

  if (valuations.length === 0) {
    return {
      fairValue: null,
      methods: [],
      confidence: 0,
      assessment: 'Insufficient data for valuation',
    };
  }

  // Weighted average
  let totalWeight = 0;
  let weightedSum = 0;
  methods.forEach(m => {
    weightedSum += m.value * m.weight;
    totalWeight += m.weight;
  });
  const fairValue = Math.round((weightedSum / totalWeight) * 100) / 100;

  // Determine if undervalued or overvalued
  const margin = ((fairValue - price) / price) * 100;
  let assessment = 'Fair Value';
  if (margin > 10) assessment = 'Undervalued (>10%)';
  else if (margin > 5) assessment = 'Slightly Undervalued';
  else if (margin < -10) assessment = 'Overvalued (>10%)';
  else if (margin < -5) assessment = 'Slightly Overvalued';

  return {
    fairValue,
    currentPrice: price,
    margin: Math.round(margin * 100) / 100,
    assessment,
    methods,
    confidence: Math.min(100, Math.round((methods.length / 5) * 100)),
    methodCount: methods.length,
  };
}

module.exports = {
  calculateGrahamNumber,
  calculateFairValueFromPEG,
  calculateDCFValue,
  calculateFairValueFromPB,
  calculateDDMValue,
  calculateIntrinsicValue,
};
