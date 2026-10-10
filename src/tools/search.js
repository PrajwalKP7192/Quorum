'use strict';

// Tavily web search via plain REST. Returns { title, url, snippet, content }[].
// Results are cached per query (one Map per run — pass cache: new Map() from
// the orchestrator so a run never pays twice for the same query).
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

function createSearch({
  apiKey = process.env.TAVILY_API_KEY,
  fetchImpl = fetch,
  cache = new Map(),
  maxResults = 5,
  timeoutMs = 30000,
} = {}) {
  if (!apiKey) {
    throw new Error(
      'TAVILY_API_KEY is not set. Web search is unavailable — add it to .env to enable research tools.'
    );
  }

  async function webSearch(query, opts = {}) {
    if (!query || typeof query !== 'string') throw new Error('webSearch: query is required');
    const limit = opts.maxResults ?? maxResults;
    const cacheKey = `${query}::${limit}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    let res;
    try {
      res = await fetchImpl(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: limit,
          search_depth: 'basic',
          include_answer: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`Tavily request failed (${err.cause?.code || err.name}): ${err.message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tavily API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const results = (data.results || []).map((r) => {
      // Cap content: tool results ride along in every subsequent LLM call, so
      // oversized blobs burn through free-tier token-per-minute limits.
      const content = (r.content || '').slice(0, 500);
      return {
        title: r.title || 'Untitled',
        url: r.url,
        snippet: content.slice(0, 200),
        content,
      };
    });
    cache.set(cacheKey, results);
    return results;
  }

  return webSearch;
}

module.exports = { createSearch, TAVILY_ENDPOINT };
