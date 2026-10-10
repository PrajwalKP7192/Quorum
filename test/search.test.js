'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSearch } = require('../src/tools/search');

function tavilyResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        { title: 'Result A', url: 'https://a.example.com', content: 'A'.repeat(1400) },
        { title: 'Result B', url: 'https://b.example.com', content: 'short' },
      ],
    }),
    text: async () => '',
  };
}

test('createSearch throws a clear error without an API key', () => {
  assert.throws(() => createSearch({ apiKey: '' }), /TAVILY_API_KEY is not set/);
});

test('webSearch maps Tavily results to { title, url, snippet, content }', async () => {
  const fetchImpl = async () => tavilyResponse();
  const webSearch = createSearch({ apiKey: 'k', fetchImpl });
  const results = await webSearch('test query', { maxResults: 2 });
  assert.equal(results.length, 2);
  assert.deepEqual(Object.keys(results[0]).sort(), ['content', 'snippet', 'title', 'url']);
  assert.equal(results[0].url, 'https://a.example.com');
  assert.equal(results[0].content.length, 500); // content capped for token budget
  assert.equal(results[0].snippet.length, 200); // content truncated for the snippet
  assert.equal(results[1].content, 'short');
});

test('webSearch caches identical queries (one HTTP call)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return tavilyResponse();
  };
  const webSearch = createSearch({ apiKey: 'k', fetchImpl });
  await webSearch('same query');
  await webSearch('same query');
  await webSearch('same query', { maxResults: 3 }); // different limit -> different cache key
  assert.equal(calls, 2);
  const body = JSON.parse('{"max_results":3}');
  assert.equal(body.max_results, 3);
});

test('webSearch sends the query with auth header', async () => {
  const captured = [];
  const fetchImpl = async (url, opts) => {
    captured.push({ url, opts });
    return tavilyResponse();
  };
  const webSearch = createSearch({ apiKey: 'secret', fetchImpl });
  await webSearch('tokyo population');
  assert.equal(captured[0].url, 'https://api.tavily.com/search');
  assert.equal(captured[0].opts.headers.authorization, 'Bearer secret');
  assert.equal(JSON.parse(captured[0].opts.body).query, 'tokyo population');
});

test('webSearch raises a clear error on non-200', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const webSearch = createSearch({ apiKey: 'k', fetchImpl });
  await assert.rejects(webSearch('q'), /Tavily API error 429.*rate limited/s);
});
