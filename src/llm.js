'use strict';

// OpenAI-compatible chat via plain fetch. Two entry points:
//   chat()            — raw chat completion (used by the tool loop)
//   structuredChat()  — chat + Zod-validated JSON output, with repair round-trips
const config = require('./config');

const JSON_INSTRUCTION = [
  'Respond with a single JSON object and nothing else — no prose, no markdown fences.',
  'The object must satisfy the schema described in the conversation.',
].join(' ');

// Provider-side parse rejections (Groq 400s when a reasoning model narrates
// instead of emitting JSON/tool calls) — retryable, model-output-side.
const PARSE_FAILURE = /output_parse_failed|could not be parsed|failed_generation|tool_use_failed|Tool choice is none/i;
const TOOL_USE_BLOCKED = /tool_use_failed|Tool choice is none/i;
const NETWORK_FAILURE = /UND_ERR|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed|network/i;

function contentText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part?.text ?? '').join('');
  }
  return '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Groq's free tier returns 429 with "Please try again in Ns" / "in 1m10.4s"
// hints; honor them (or exponential backoff) before giving up.
const MAX_429_RETRIES = 6;

function parseRetryHint(res, bodyText) {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return n;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  }
  const m = bodyText.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : null;
}

async function chat({
  messages,
  model,
  tools,
  temperature = 0.2,
  maxTokens,
  apiKey = config.OPENAI_API_KEY,
  baseUrl = config.OPENAI_BASE_URL,
  timeoutMs = config.REQUEST_TIMEOUT_MS,
  retryBaseDelayMs = 5000,
  fetchImpl = fetch,
  trace,
} = {}) {
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in (any OpenAI-compatible key).'
    );
  }
  if (!messages || !messages.length) throw new Error('chat() requires messages');

  const body = { model: model || config.LLM_MODEL, messages, temperature };
  if (tools && tools.length) body.tools = tools;
  if (maxTokens) body.max_tokens = maxTokens;
  // gpt-oss models: fewer reasoning tokens — easier on TPM limits and less
  // tool-call narration that Groq's server-side parser can reject.
  if (/gpt-oss/i.test(body.model)) body.reasoning_effort = body.reasoning_effort || 'low';

  let res;
  let attempt429 = 0;
  const started = Date.now();
  while (true) {
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const code = err.cause?.code || err.name;
      // Transient network errors (connect timeouts, resets) get the same
      // retry budget as rate limits — Groq free-tier load causes both.
      if (attempt429 < MAX_429_RETRIES && NETWORK_FAILURE.test(`${code} ${err.message}`)) {
        const waitMs = retryBaseDelayMs + Math.random() * 3000;
        console.error(`llm: network error (${code}) — retrying in ${(waitMs / 1000).toFixed(1)}s ...`);
        await sleep(waitMs);
        attempt429++;
        continue;
      }
      throw new Error(`LLM request failed (${code}): ${err.message}`);
    }

    if (res.ok) break;

    const text = await res.text().catch(() => '');
    if (res.status === 429 && attempt429 < MAX_429_RETRIES) {
      const hint = parseRetryHint(res, text);
      const waitMs = Math.min(
        (hint ?? Math.min(2 ** attempt429 * 5, 30)) * 1000 + Math.random() * 1000,
        90000
      );
      console.error(`llm: rate limited (429) — retrying in ${(waitMs / 1000).toFixed(1)}s ...`);
      await sleep(waitMs);
      attempt429++;
      continue;
    }
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('LLM API returned no choices');
  if (trace) {
    await trace.event('llm_call', {
      model: body.model,
      latencyMs: Date.now() - started,
      retries: attempt429,
      prompt_tokens: data.usage?.prompt_tokens ?? null,
      completion_tokens: data.usage?.completion_tokens ?? null,
    });
  }
  return { message: choice.message, usage: data.usage ?? null, raw: data };
}

// Best-effort JSON extraction: bare JSON, fenced JSON, or the outermost braces.
function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  throw new Error('no parseable JSON object in LLM output');
}

function formatIssues(error) {
  if (error && Array.isArray(error.issues)) {
    return error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('\n');
  }
  // Not a ZodError (e.g. JSON parsing failed) — use its message.
  return String(error?.message || error);
}

async function structuredChat({
  system,
  messages = [],
  schema,
  model,
  temperature = 0,
  maxRepairAttempts = config.MAX_REPAIR_ATTEMPTS,
  apiKey,
  baseUrl,
  timeoutMs,
  fetchImpl,
  trace,
} = {}) {
  if (!schema) throw new Error('structuredChat() requires a Zod schema');

  const convo = [
    {
      role: 'system',
      content: system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION,
    },
    ...messages,
  ];

  let lastError;
  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    let message;
    let usage;
    try {
      ({ message, usage } = await chat({
        messages: convo,
        model,
        // Escalate temperature on retries: at temp 0 the same input would
        // deterministically produce the same rejected output.
        temperature: attempt > 0 ? Math.max(temperature, 0.3) : temperature,
        apiKey,
        baseUrl,
        timeoutMs,
        fetchImpl,
        trace,
      }));
    } catch (err) {
      // Groq can reject an unparseable model turn with a 400 before we ever
      // see output — retry it inside the same repair budget.
      if (attempt < maxRepairAttempts && PARSE_FAILURE.test(err.message)) {
        lastError = err;
        convo.push({
          role: 'user',
          content: TOOL_USE_BLOCKED.test(err.message)
            ? 'Tools are disabled for this request. Do not call any tools. Respond with the JSON object as plain text only.'
            : 'Your last output could not be parsed by the API. Respond again with the JSON object only.',
        });
        continue;
      }
      throw err;
    }
    const text = contentText(message);

    let value;
    try {
      value = extractJson(text);
    } catch (err) {
      lastError = err;
    }

    if (value !== undefined) {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        return { data: parsed.data, attempts: attempt + 1, usage };
      }
      lastError = parsed.error;
    }

    // Repair round-trip: show the model exactly why its output was rejected.
    convo.push({ role: 'assistant', content: text });
    convo.push({
      role: 'user',
      content: `That JSON was rejected. Problem:\n${formatIssues(lastError)}\n\nReturn the corrected JSON object only.`,
    });
  }

  throw new Error(
    `structuredChat: output failed schema validation after ${maxRepairAttempts + 1} attempt(s).\nLast problem:\n${formatIssues(lastError)}`
  );
}

module.exports = { chat, structuredChat, extractJson, contentText };
