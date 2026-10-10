'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkOneCitation, checkCitations, normalize } = require('../src/tools/citation-check');

const VERDICT = {
  claimId: 'c1',
  verdict: 'supported',
  evidenceQuote: 'Canberra is the capital city of Australia.',
  url: 'https://en.wikipedia.org/wiki/Canberra',
};

function pageFetch(html) {
  return async () => ({
    ok: true,
    status: 200,
    url: VERDICT.url,
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  });
}

const WRAPPED = `<html><body><span data-x='{"a":1}'>Canberra</span> is <b>the</b> capital
  city   of Australia, founded in 1913.</body></html>`;

test('checkOneCitation finds the quote despite tags, casing and whitespace', async () => {
  const r = await checkOneCitation(VERDICT, { fetchImpl: pageFetch(WRAPPED) });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'quote-found');
});

test('checkOneCitation survives per-letter spans via the space-less fallback', async () => {
  // page renders "KAN-brə" as separate spans; the quote keeps it continuous
  const html = '<body><p>C An b r a is the capital city of Australia.</p></body>';
  const r = await checkOneCitation(
    { ...VERDICT, evidenceQuote: 'CAN-bra is the capital city of Australia.' },
    { fetchImpl: pageFetch(html) }
  );
  assert.equal(r.ok, true);
});

test('checkOneCitation reports a fabricated quote', async () => {
  const html = '<body><p>Canberra is a small town in Antarctica.</p></body>';
  const r = await checkOneCitation(VERDICT, { fetchImpl: pageFetch(html) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quote-not-found-on-page');
});

test('checkOneCitation reports fetch failures with the reason', async () => {
  const fetchImpl = async () => {
    throw new Error('DNS gone');
  };
  const r = await checkOneCitation(VERDICT, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fetch-failed/);
});

test('checkCitations only checks supported verdicts, preserving order', async () => {
  const html = '<body><p>Canberra is the capital city of Australia.</p></body>';
  const verdicts = [
    { ...VERDICT, claimId: 'c1' },
    { ...VERDICT, claimId: 'c2', verdict: 'contradicted' },
    { ...VERDICT, claimId: 'c3', evidenceQuote: 'totally fabricated words here' },
  ];
  const results = await checkCitations(verdicts, { fetchImpl: pageFetch(html) });
  assert.deepEqual(results.map((r) => r.claimId), ['c1', 'c3']); // c2 skipped (not supported)
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
});

test('normalize strips punctuation, case and unicode punctuation', () => {
  assert.equal(normalize('Canberra— /ˈkænbrə/ ⓘ; "Capital"!'), 'canberra k nbr capital');
});
