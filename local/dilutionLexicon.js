/**
 * Domain-specific dilution feature set — deliberately NOT part of the Loughran-McDonald
 * lexicon and never labeled as "LM Negative."
 *
 * Verified against the real LM Master Dictionary (Loughran-McDonald_MasterDictionary_
 * 1993-2025.csv, downloaded 2026-08-12, Last-Modified: Wed, 01 Apr 2026 23:18:09 GMT,
 * sraf.nd.edu/loughranmcdonald-master-dictionary/), full-dictionary scan (all 86,553
 * rows, every category column, not just Negative): DILUTE, DILUTED, DILUTION, DILUTIVE,
 * ANTIDILUTIVE all exist as tracked vocabulary entries but carry zero classification
 * across every LM category (Negative, Positive, Uncertainty, Litigious, Constraining
 * all = 0 for each). So a strict LM-Negative-only tone feature cannot capture
 * dilution-related language directly — this module fills that gap as an independent,
 * separately-reported measure. See lmSentiment.js for the unmodified LM tone score.
 *
 * Scope honesty: dilution_mention (exact token match) is as reliable as any lexicon
 * count. potential_dilution/actual_dilution/anti_dilution are regex heuristics written
 * against a small number of real observed filing sentences (see server.js session
 * history) — they have NOT been precision/recall-validated against a labeled corpus.
 * Treat them as a starting point requiring manual review of matched contexts, not a
 * validated classifier, per the same standard applied to the LM score itself.
 */

const DILUTION_TERMS = new Set([
  'DILUTE', 'DILUTED', 'DILUTES', 'DILUTING', 'DILUTION', 'DILUTIONS', 'DILUTIVE',
  'ANTIDILUTIVE',
]);

function tokenize(text) {
  return String(text || '').toUpperCase().match(/[A-Z]+/g) || [];
}

// Unhedged/declarative dilution language — "will dilute", "will result in dilution to",
// "results in dilution" — observed verbatim in a real RKLB 10-K ("...will dilute all
// other stockholders... will result in dilution to all other stockholders...").
const ACTUAL_OR_DECLARED_PATTERNS = [
  /\bwill\s+dilute\b/i,
  /\bwill\s+result\s+in\s+dilution\b/i,
  /\bresult(?:s|ed|ing)?\s+in\s+dilution\b/i,
  /\bdiluted\s+(?:eps|earnings\s+per\s+share)\s+(?:decreased|declined|fell|dropped)/i,
];

// Hedged/conditional dilution language — "could be dilutive", "may result in dilution",
// "potentially dilutive". Distinguished from the block above because a trader reading
// "will dilute" vs "could potentially dilute" is reading two different risk levels.
const POTENTIAL_PATTERNS = [
  /\b(?:could|may|might|would)\s+(?:be|result\s+in|cause)\b[\w\s,]{0,40}\bdilut\w*/i,
  /\bpotential(?:ly)?\s+dilut\w*/i,
];

const ANTI_DILUTION_PATTERNS = [
  /\banti-?dilution\s+(?:provision|protection|clause|right|adjustment)/i,
  /\bantidilutive\b/i,
];

function countPatternMatches(text, patterns) {
  let n = 0;
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    n += (text.match(g) || []).length;
  }
  return n;
}

function scoreDilution(text) {
  const raw = String(text || '');
  const tokens = tokenize(raw);
  return {
    dilution_mention: tokens.filter(t => DILUTION_TERMS.has(t)).length,
    actual_dilution: countPatternMatches(raw, ACTUAL_OR_DECLARED_PATTERNS),
    potential_dilution: countPatternMatches(raw, POTENTIAL_PATTERNS),
    anti_dilution: countPatternMatches(raw, ANTI_DILUTION_PATTERNS),
  };
}

module.exports = { DILUTION_TERMS, scoreDilution };
