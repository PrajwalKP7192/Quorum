'use strict';

// OpenAI-compatible chat via plain fetch. Two entry points:
//   chat()            — raw chat completion (used by the tool loop)
//   structuredChat()  — chat + Zod-validated JSON output, with repair round-trips
const config = require('./config');

const JSON_INSTRUCTION = [
  'Respond with a single JSON object and nothing else — no prose, no markdown fences.',
  'The object must satisfy the schema described in the conversation.',
].join(' ');

function contentText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part?.text ?? '').join('');
  }
  return '';
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
  fetchImpl = fetch,
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

  let res;
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
    throw new Error(`LLM request failed (${err.cause?.code || err.name}): ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('LLM API returned no choices');
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
    const { message, usage } = await chat({
      messages: convo,
      model,
      temperature,
      apiKey,
      baseUrl,
      timeoutMs,
      fetchImpl,
    });
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
