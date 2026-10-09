'use strict';

// The standard toolbelt given to agents: web search + page fetch.
// One search cache per run — pass a fresh Map from the orchestrator.
const { createSearch } = require('./search');
const { fetchPage } = require('./fetch');

function buildTools({ searchCache = new Map(), fetchImpl, maxChars } = {}) {
  const webSearch = createSearch({ cache: searchCache, fetchImpl });
  return [
    {
      name: 'web_search',
      description:
        'Search the web. Returns a list of results with title, url, snippet and content. Use for finding sources.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: { type: 'integer', description: 'Max results (default 5)', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
      execute: (args) => webSearch(args.query, { maxResults: args.max_results }),
    },
    {
      name: 'open_page',
      description:
        'Fetch a web page and return its readable text. Use when a search snippet is not enough to pin down a fact.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to open (http/https)' },
        },
        required: ['url'],
      },
      execute: (args) => fetchPage(args.url, { fetchImpl, maxChars }),
    },
  ];
}

module.exports = { buildTools };
