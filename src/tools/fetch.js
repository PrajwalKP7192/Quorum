'use strict';

// Fetch a web page and extract readable text. Mechanical: strip scripts,
// styles, comments and tags, decode entities, collapse whitespace. Size-capped.

const USER_AGENT = 'QuorumBot/0.1 (research agent; +https://localhost)';

function decodeEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
    copy: '©',
    reg: '®',
    trade: '™',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ') // comments
      .replace(/<head[^>]*>[\s\S]*?<\/head\s*>/gi, ' ') // head never renders
      .replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ') // non-content blocks
      .replace(/<(br|\/p|\/div|\/section|\/article|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n') // line breaks
      // Tag strip that tolerates ">" inside quoted attribute values — without
      // this, attribute JSON (e.g. Wikipedia's data-mw='...'>) leaks into text
      // and crowds out the real content under the size cap.
      .replace(/<("[^"]*"|'[^']*'|[^'">])*>/g, ' ') // remaining tags
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

async function fetchPage(url, {
  fetchImpl = fetch,
  timeoutMs = 30000,
  maxBytes = 2 * 1024 * 1024,
  maxChars = 20000,
} = {}) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error(`fetchPage: not an http(s) URL: ${url}`);

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`fetchPage failed for ${url} (${err.cause?.code || err.name}): ${err.message}`);
  }

  if (!res.ok) throw new Error(`fetchPage: ${res.status} ${res.statusText} for ${url}`);

  const contentType = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)) {
    throw new Error(`fetchPage: unsupported content-type "${contentType}" for ${url}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const html = buf.subarray(0, maxBytes).toString('utf8');
  const text = htmlToText(html);
  return {
    url: res.url || url,
    title: extractTitle(html) || 'Untitled',
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars || buf.length > maxBytes,
  };
}

module.exports = { fetchPage, htmlToText, decodeEntities };
