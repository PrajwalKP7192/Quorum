'use strict';

// Verify every claim in parallel with a concurrency cap. One claim's failure
// never fails the batch (verifyClaim already degrades to "unverifiable";
// this is the belt-and-braces layer).
const config = require('./config');
const { verifyClaim, fallbackVerdict } = require('./agents/fact-checker');

async function verifyAll(
  claims,
  { llm, tools, concurrency = config.VERIFY_CONCURRENCY, checkerModel, verifyOne = verifyClaim } = {}
) {
  if (!Array.isArray(claims)) throw new Error('verifyAll: claims must be an array');
  const verdicts = new Array(claims.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= claims.length) return;
      const claim = claims[i];
      try {
        verdicts[i] = await verifyOne({ claim, llm, tools, model: checkerModel });
      } catch (err) {
        verdicts[i] = fallbackVerdict(claim, `verification crashed: ${err.message}`);
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, claims.length)) }, worker);
  await Promise.all(workers);
  return verdicts;
}

module.exports = { verifyAll };
