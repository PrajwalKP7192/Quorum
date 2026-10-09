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

async function runToolLoop({ llm, system, messages = [], tools = [], maxSteps = 8, temperature }) {
  const convo = [{ role: 'system', content: system }, ...messages];
  const usageAcc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finalMessage = null;

  for (let step = 1; step <= maxSteps; step++) {
    const { message, usage } = await llm.chat({
      messages: convo,
      tools: tools.length ? tools.map(toOpenAITool) : undefined,
      temperature,
    });
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
