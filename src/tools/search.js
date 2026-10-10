'use strict';

// Tavily web search via plain REST. Returns { title, url, snippet, content }[].
// Results are cached per query (one Map per run — pass cache: new Map() from
// the orchestrator so a run never pays twice for the same query).
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

// Domain trust weighting for ranking: official/academic sources first.
function domainWeight(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 0;
  }
  // gov/gov.uk/go.jp = government; edu/ac.uk (and regional edu TLDs) = academic
  if (/\.(gov(\.uk)?|go\.jp|edu(\.[a-z]{2})?|ac\.uk|mil)$/.test(host)) return 3;
  if (/(\.org|\.int)$/.test(host)) return 2;
  return 1;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // strip trailing slash + tracking params; same page = same result
    for (const p of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^ref_/i.test(p)) u.searchParams.delete(p);
    }
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url;
  }
}

function rankResults(results) {
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const recencyBonus = (r) => {
    if (!r.publishedDate) return 0;
    const ageDays = (Date.now() - Date.parse(r.publishedDate)) / 86400000;
    return Number.isFinite(ageDays) && ageDays < 365 ? 1 : 0;
  };
  // relevance first within a trust tier; recency breaks near-ties
  return unique.sort(
    (a, b) =>
      domainWeight(b.url) - domainWeight(a.url) ||
      (b.relevance ?? 0) - (a.relevance ?? 0) ||
      recencyBonus(b) - recencyBonus(a)
  );
}

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
    const results = rankResults(
      (data.results || []).map((r) => {
        // Cap content: tool results ride along in every subsequent LLM call, so
        // oversized blobs burn through free-tier token-per-minute limits.
        const content = (r.content || '').slice(0, 500);
        return {
          title: r.title || 'Untitled',
          url: r.url,
          snippet: content.slice(0, 200),
          content,
          relevance: r.score ?? 0,
          publishedDate: r.published_date || null,
        };
      })
    ).map(({ relevance, publishedDate, ...rest }) => rest); // agents see the lean shape
    cache.set(cacheKey, results);
    return results;
  }

  return webSearch;
}

module.exports = { createSearch, TAVILY_ENDPOINT };
