/**
 * Deterministic Loughran-McDonald financial sentiment scoring.
 *
 * Word lists in lmSentiment.json are extracted verbatim from the real LM Master
 * Dictionary (sraf.nd.edu/loughranmcdonald-master-dictionary/) — 2355 Negative words,
 * 354 Positive words, plus Uncertainty/Litigious/Constraining as supplementary
 * diagnostics. No LLM, no embeddings, no subjective judgment anywhere in this file —
 * every function here is a pure count-and-divide computation. Same input text always
 * produces the same output number.
 *
 * IMPORTANT SCOPE NOTE: LM was built and validated specifically on 10-K prose. Applying
 * it to crawled news/social text (as opposed to actual filing text) is a weaker
 * methodological fit — many LM-negative words (e.g. "claim", "material", "adverse") are
 * negative specifically in a legal/filing register, not in ordinary journalism. Prefer
 * scoreDocument()/scoreWeightedSections() against real filing text (what
 * extractRiskAndMDA() in server.js already extracts) over crawled sentiment prose.
 */
const LM = require('./lmSentiment.json');

const POS = new Set(LM.Positive);
const NEG = new Set(LM.Negative);
const UNC = new Set(LM.Uncertainty);
const LIT = new Set(LM.Litigious);
const CON = new Set(LM.Constraining);

// Tokenization: uppercase-fold, split on any non-letter run. No stemming (the LM
// dictionary is exact word-form, not stemmed — "ABANDON" and "ABANDONED" are separate
// entries), no stopword removal (irrelevant — only dictionary-listed tokens are ever
// counted), numbers/tickers/punctuation are dropped as token separators since they can
// never match a lexicon entry anyway.
function tokenize(text) {
  return String(text || '').toUpperCase().match(/[A-Z]+/g) || [];
}

// Core count-and-ratio computation over a token array. Returns every intermediate
// number, not just the final score, so the pipeline is auditable end to end.
function scoreTokens(tokens) {
  let pos = 0, neg = 0, unc = 0, lit = 0, con = 0;
  for (const t of tokens) {
    if (POS.has(t)) pos++;
    if (NEG.has(t)) neg++;
    if (UNC.has(t)) unc++;
    if (LIT.has(t)) lit++;
    if (CON.has(t)) con++;
  }
  const totalWords = tokens.length;
  const sentimentWords = pos + neg; // POS + NEG only — the denominator for PSS/NSP-word-based

  // Primary formula — Proportional Sentiment Scoring (PSS), denominator = POS+NEG.
  // Mathematically identical to NSP with the (POS+NEG) denominator variant: both reduce
  // to (POS-NEG)/(POS+NEG). Chosen as primary because it's invariant to document length
  // and gives real resolution — a whole-document denominator (N) drowns the signal, since
  // sentiment-bearing words are typically 1-3% of a 10-K's total token count.
  const pssRaw = sentimentWords > 0 ? (pos - neg) / sentimentWords : 0;
  const pss0to100 = clamp0to100(50 * (pssRaw + 1));

  // Secondary formula — NSP with whole-document denominator (N). Reported for
  // transparency/completeness per spec; expect this to sit very close to 50 (low
  // resolution) on real filing text — that compression is a real, expected property of
  // this variant, not a bug.
  const nspDocRaw = totalWords > 0 ? (pos - neg) / totalWords : 0;
  const nspDoc0to100 = clamp0to100(50 * (nspDocRaw + 1));

  return {
    pos, neg, unc, lit, con, totalWords, sentimentWords,
    pss_raw: round4(pssRaw), pss_0_100: Math.round(pss0to100),
    nsp_doc_raw: round4(nspDocRaw), nsp_doc_0_100: Math.round(nspDoc0to100),
  };
}

function scoreDocument(text) {
  return scoreTokens(tokenize(text));
}

// Multiple filings / sections for one ticker: pools raw POS/NEG/N counts BEFORE
// computing the ratio (not an average of per-section scores) — a short section isn't
// allowed to move the needle as much as a long one, and pooling is the statistically
// sound way to combine count data. `weights` optionally scales each section's counts
// (e.g. weight MD&A tone higher than boilerplate-heavy Risk Factors) — default 1 each.
function scoreWeightedSections(sections) {
  // sections: [{ label, text, weight? }]
  const perSection = sections.map(s => ({
    label: s.label,
    weight: s.weight != null ? s.weight : 1,
    ...scoreTokens(tokenize(s.text)),
  }));

  let pos = 0, neg = 0, totalWords = 0;
  for (const s of perSection) {
    pos += s.pos * s.weight;
    neg += s.neg * s.weight;
    totalWords += s.totalWords * s.weight;
  }
  const sentimentWords = pos + neg;
  const pssRaw = sentimentWords > 0 ? (pos - neg) / sentimentWords : 0;
  const combined_pss_0_100 = Math.round(clamp0to100(50 * (pssRaw + 1)));

  return { per_section: perSection, pooled: { pos, neg, totalWords, sentimentWords, pss_raw: round4(pssRaw) }, combined_pss_0_100 };
}

function clamp0to100(v) { return Math.max(0, Math.min(100, v)); }
function round4(v) { return Math.round(v * 10000) / 10000; }

module.exports = { tokenize, scoreTokens, scoreDocument, scoreWeightedSections };
