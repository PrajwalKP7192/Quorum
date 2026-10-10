'use strict';

// Mechanical citation check — no LLM. For each verdict, fetch the cited URL
// and confirm the evidenceQuote actually appears on the page (whitespace-
// normalized, case-insensitive: models routinely recase a quote's first letter,
// but the words must be there). Catches fabricated evidence quotes.
const { fetchPage } = require('./fetch');

// Normalize aggressively: case- and punctuation-insensitive. Models recase
// quotes and pages render punctuation/glyphs differently (dashes, icons,
// accented pronunciation guides) — the words are what must match.
function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function checkOneCitation(verdict, { fetchImpl } = {}) {
  const base = { claimId: verdict.claimId, url: verdict.url, ok: false, reason: '' };
  let page;
  try {
    // Bigger text budget than the LLM tools: this text is only string-searched,
    // and heavy pages (nav menus, infoboxes) push article text past the default cap.
    page = await fetchPage(verdict.url, { fetchImpl, maxChars: 60000 });
  } catch (err) {
    return { ...base, reason: `fetch-failed: ${err.message.slice(0, 120)}` };
  }
  if (normalize(page.text).includes(normalize(verdict.evidenceQuote))) {
    return { ...base, ok: true, reason: 'quote-found' };
  }
  // Fallback: word boundaries can differ between the quote and the page
  // (e.g. per-letter pronunciation spans), so also try fully space-less match.
  const squish = (t) => normalize(t).replace(/ /g, '');
  if (squish(page.text).includes(squish(verdict.evidenceQuote))) {
    return { ...base, ok: true, reason: 'quote-found' };
  }
  return { ...base, reason: 'quote-not-found-on-page' };
}

// Checks the SUPPORTED verdicts (those quotes are what the report stands on).
// Concurrency-capped; one bad URL never fails the batch.
async function checkCitations(verdicts, { fetchImpl, concurrency = 4 } = {}) {
  const supported = verdicts.filter((v) => v.verdict === 'supported');
  const results = new Array(supported.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= supported.length) return;
      try {
        results[i] = await checkOneCitation(supported[i], { fetchImpl });
      } catch (err) {
        results[i] = { claimId: supported[i].claimId, url: supported[i].url, ok: false, reason: `crashed: ${err.message}` };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, supported.length)) }, worker));
  return results;
}

module.exports = { checkCitations, checkOneCitation, normalize };
