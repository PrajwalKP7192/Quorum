'use strict';

// Generic OpenAI tool-calling loop. The LLM client is injected, so tests
// drive it with a scripted fake. Tools are plain objects:
//   { name, description, parameters (JSON schema), execute(args) }
// Returns the full message history (ready to hand to structuredChat) plus
// the final message and accumulated usage.

function toOpenAITool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

async function executeToolCall(tool, call) {
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return { ok: false, output: `Error: tool arguments are not valid JSON: ${call.function.arguments}` };
  }
  try {
    const result = await tool.execute(args);
    return { ok: true, output: typeof result === 'string' ? result : JSON.stringify(result) };
  } catch (err) {
    return { ok: false, output: `Error: ${err.message}` };
  }
}

// Some providers (e.g. Groq) validate tool-call names server-side and reject
// the request with a 400 when the model invents a tool name ("web_open" for
// "open_page"). Recover by telling the model the real tool names and retrying.
function extractUnknownTool(errorMessage) {
  const m = String(errorMessage).match(/call tool '([^']+)' which was not in request\.tools/i)
    || String(errorMessage).match(/attempted to call tool '([^']+)'/i);
  return m ? m[1] : null;
}

// Groq also 400s when a (reasoning) model narrates a tool call in plain text
// instead of emitting one ("output_parse_failed"). Both failures are
// model-output-side, so a corrective nudge + retry usually fixes them.
const PARSE_FAILURE = /output_parse_failed|could not be parsed|failed_generation/i;

function classifyChatError(errorMessage) {
  const unknownTool = extractUnknownTool(errorMessage);
  if (unknownTool) return { kind: 'unknown-tool', unknownTool };
  if (PARSE_FAILURE.test(errorMessage)) return { kind: 'parse' };
  return { kind: 'fatal' };
}

async function chatWithRepair(llm, convo, chatOpts, toolNames, maxRepairs = 3) {
  for (let repair = 0; ; repair++) {
    try {
      return await llm.chat({ messages: convo, ...chatOpts });
    } catch (err) {
      const kind = classifyChatError(err.message);
      if (repair >= maxRepairs || kind.kind === 'fatal') throw err;
      if (kind.kind === 'unknown-tool') {
        convo.push({
          role: 'user',
          content: `Error: there is no tool named "${kind.unknownTool}". The only available tools are: ${toolNames.join(', ')}. Call one of those by its exact name.`,
        });
      } else {
        convo.push({
          role: 'user',
          content: `Your last output could not be parsed. Either make a proper function call to one of: ${toolNames.join(', ')} — or reply with plain text. Never write tool calls as plain text.`,
        });
      }
    }
  }
}

// Groq free tier: 8K tokens/minute per model — a single oversized request is
// rejected outright (413). Keep the growing transcript under this budget by
// truncating the OLDEST tool results first (recent evidence matters most).
const DEFAULT_TOKEN_BUDGET = 5000;
const estimateTokens = (text) => Math.ceil((text || '').length / 4);

function trimTranscript(convo, budgetTokens = DEFAULT_TOKEN_BUDGET) {
  let total = convo.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  for (let i = 0; i < convo.length && total > budgetTokens; i++) {
    const m = convo[i];
    if (m.role === 'tool' && m.content.length > 200) {
      total -= estimateTokens(m.content) - estimateTokens(m.content.slice(0, 200));
      m.content = `${m.content.slice(0, 200)} ...[trimmed to fit the token budget]`;
    }
  }
  return convo;
}

async function runToolLoop({ llm, system, messages = [], tools = [], maxSteps = 8, temperature, tokenBudget = DEFAULT_TOKEN_BUDGET }) {
  const convo = [{ role: 'system', content: system }, ...messages];
  const usageAcc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finalMessage = null;

  for (let step = 1; step <= maxSteps; step++) {
    trimTranscript(convo, tokenBudget);
    const { message, usage } = await chatWithRepair(
      llm,
      convo,
      { tools: tools.length ? tools.map(toOpenAITool) : undefined, temperature },
      tools.map((t) => t.name)
    );
    finalMessage = message;
    if (usage) {
      usageAcc.prompt_tokens += usage.prompt_tokens ?? 0;
      usageAcc.completion_tokens += usage.completion_tokens ?? 0;
      usageAcc.total_tokens += usage.total_tokens ?? 0;
    }

    const calls = message.tool_calls || [];
    if (!calls.length) {
      return { messages: convo, finalMessage, usage: usageAcc, steps: step, hitMaxSteps: false };
    }

    convo.push(message);
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.function?.name);
      const { ok, output } = tool
        ? await executeToolCall(tool, call)
        : { ok: false, output: `Error: unknown tool "${call.function?.name}"` };
      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        ...(ok ? {} : { name: call.function?.name }),
        content: output,
      });
    }
  }

  // maxSteps reached: the last assistant message asked for more tools.
  // Hand back the transcript anyway — callers (e.g. the researcher) close the
  // loop with their own structured-output request.
  return { messages: convo, finalMessage, usage: usageAcc, steps: maxSteps, hitMaxSteps: true };
}

module.exports = { runToolLoop };
