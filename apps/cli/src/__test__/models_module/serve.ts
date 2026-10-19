// A third-party models module for the tests: the models slot's one method
// (docs/contracts/models-slot.md) served as adapter protocol 2 over HTTP, on
// the socket lf names (`MODULE_SOCKET`). It answers every call with the same
// text, priced at 2500 microdollars, and the tokens it spent; with
// `ACME_LLM_NO_USAGE` set it leaves the tokens out, as a module must not.

import { serveSlot } from 'movement-engine/public/module-wire';

import { ACME_LLM_ANSWER } from './project';

void serveSlot({
  manifest: { protocolVersion: 2, name: 'acme_llm', kind: 'core', slot: 'models', methods: ['models.call'] },
  print: true,
  answer: async (method) => {
    if (method !== 'models.call') throw new Error(`no method "${method}"`);
    const usage = process.env.ACME_LLM_NO_USAGE ? {} : { usage: { inputTokens: 12, outputTokens: 7 } };
    return { text: ACME_LLM_ANSWER, cost: [{ label: 'acme_llm/small', microdollars: 2500 }], ...usage };
  },
});
