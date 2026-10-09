'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchPage, htmlToText, decodeEntities } = require('../src/tools/fetch');

test('htmlToText strips scripts, styles and tags', () => {
  const html = `<!doctype html><html><head><style>p{color:red}</style></head>
    <body><script>var x = "<div>not text</div>";</script>
    <h1>Hello</h1><p>World &amp; more&nbsp;text.</p><!-- hidden --></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('Hello'));
  assert.ok(text.includes('World & more text.'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('not text'));
  assert.ok(!text.includes('hidden'));
  assert.ok(!/<[a-z]/i.test(text));
});

test('decodeEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeEntities('&#x27;hex&#x27;'), "'hex'");
  assert.equal(decodeEntities('caf&eacute;'), 'caf&eacute;'); // unknown entity left alone
});

test('fetchPage extracts title, text and follows content-type rules', async () => {
  const html = '<html><head><title>  My &amp; Page </title></head><body><p>Body text.</p></body></html>';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    url: 'https://example.com/final',
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  });
  const page = await fetchPage('https://example.com', { fetchImpl });
  assert.equal(page.title, 'My & Page');
  assert.equal(page.text, 'Body text.');
  assert.equal(page.url, 'https://example.com/final');
  assert.equal(page.truncated, false);
});

test('fetchPage rejects non-200 and unsupported content types', async () => {
  const notOk = async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(fetchPage('https://example.com/x', { fetchImpl: notOk }), /404/);

  const pdf = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/pdf' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(fetchPage('https://example.com/doc.pdf', { fetchImpl: pdf }), /unsupported content-type/);
});

test('fetchPage truncates text to maxChars and flags it', async () => {
  const html = `<html><body>${'<p>abcdefghij.</p>'.repeat(10)}</body></html>`;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  });
  const page = await fetchPage('https://example.com', { fetchImpl, maxChars: 20 });
  assert.ok(page.text.length <= 20);
  assert.equal(page.truncated, true);
});

test('fetchPage rejects non-http URLs', async () => {
  await assert.rejects(fetchPage('ftp://example.com', { fetchImpl: async () => {} }), /not an http/);
});
