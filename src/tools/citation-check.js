'use strict';

// Mechanical citation check — no LLM. For each verdict, fetch the cited URL
// and confirm the evidenceQuote actually appears on the page (whitespace-
// normalized, case-insensitive: models routinely recase a quote's first letter,
// but the words must be there). Catches fabricated evidence quotes.
const { fetchPage } = require('./fetch');

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function checkOneCitation(verdict, { fetchImpl } = {}) {
  const base = { claimId: verdict.claimId, url: verdict.url, ok: false, reason: '' };
  let page;
  try {
    page = await fetchPage(verdict.url, { fetchImpl });
  } catch (err) {
    return { ...base, reason: `fetch-failed: ${err.message.slice(0, 120)}` };
  }
  if (normalize(page.text).includes(normalize(verdict.evidenceQuote))) {
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
