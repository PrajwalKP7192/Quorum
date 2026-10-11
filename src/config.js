'use strict';

// Load .env from the project root if present (Node >= 20.12, no dotenv dep).
try {
  process.loadEnvFile();
} catch {
  // No .env file — configuration comes from the real environment.
}

const positiveInt = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

module.exports = {
  // LLM endpoint (any OpenAI-compatible API)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_BASE_URL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
  RESEARCHER_MODEL: process.env.RESEARCHER_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
  CHECKER_MODEL: process.env.CHECKER_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini',
  REQUEST_TIMEOUT_MS: positiveInt(process.env.REQUEST_TIMEOUT_MS, 60000),
  MAX_REPAIR_ATTEMPTS: positiveInt(process.env.MAX_REPAIR_ATTEMPTS, 2),

  // Web search (Phase 1)
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',

  // Orchestration (Phases 2-3)
  MAX_ROUNDS: positiveInt(process.env.MAX_ROUNDS, 2),
  VERIFY_CONCURRENCY: positiveInt(process.env.VERIFY_CONCURRENCY, 4),

  // Quality (Phase 4)
  CITATION_CHECK: process.env.CITATION_CHECK || 'warn',

  // Phase 7 extensions
  SKEPTIC: process.env.SKEPTIC || 'on',
  PARALLEL_RESEARCH: process.env.PARALLEL_RESEARCH || 'off',
  RESEARCH_CONCURRENCY: positiveInt(process.env.RESEARCH_CONCURRENCY, 3),

  // Service (Phase 6)
  PORT: positiveInt(process.env.PORT, 8080),
};
