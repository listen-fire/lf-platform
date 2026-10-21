// The TypeScript engine's run context: the segment the run host opened
// (segment_context.ts, shared with the Rust engine's shim), and the host's
// priced families as the interpreter calls them.

import { CURRENT_LANGUAGE_VERSION, pluginOutputUnder, type LanguageVersion } from 'movement-lang';

import type { FileRef } from 'movement-engine/public/adapter';
import type { LlmClient, ExtractCallLlmClient, Budget } from 'movement-engine/public/models';
import type {
  ArbitrationAnswer,
  BudgetRefusal,
  EngineHost,
  EntityArbitration,
  PricedAnswer,
} from 'movement-engine/public/host';
import type { FileTextResolution } from 'movement-engine/public/files';
import type { MovementTransformInvoker } from './extraction';
import {
  pluginSpecNamed,
  withDeclaredFiles,
  type PluginSpecs,
  type RunLedger,
} from 'movement-engine/public/segment-context';

export * from 'movement-engine/public/segment-context';

/**
 * One priced host call: handed the run's budget, its reported cost charged.
 * A call the host refused past the budget is charged what it spent before the
 * refusal and raised as the run's cap, from the run's figures.
 */
async function charged<Output extends object>(
  ledger: RunLedger,
  call: (budget: Budget) => Promise<PricedAnswer<Output>>,
): Promise<Output> {
  const answer = await call(ledger.budget());
  ledger.charge(answer.cost);
  if (isBudgetRefusal(answer)) throw ledger.exceeded() ?? new Error(answer.error.message);
  return answer;
}

function isBudgetRefusal<Output extends object>(answer: PricedAnswer<Output>): answer is BudgetRefusal {
  return (
    'error' in answer &&
    typeof answer.error === 'object' &&
    answer.error !== null &&
    'kind' in answer.error &&
    answer.error.kind === 'budget'
  );
}

/** The host's priced families as the interpreter calls them: the run's budget
 *  goes in and what each call spent is charged, so no call site can forget
 *  either. */
export interface PricedCalls {
  client: LlmClient;
  extractCall: ExtractCallLlmClient;
  transforms: MovementTransformInvoker;
  arbitrateEntities: (input: EntityArbitration) => Promise<ArbitrationAnswer>;
  resolveFileText: (input: { file: FileRef }) => Promise<FileTextResolution>;
}

export function pricedCalls(
  host: EngineHost,
  run: {
    /** The segment every call is made in. */
    segmentId: string;
    ledger: RunLedger;
    /** The run's catalog snapshot's plugins: which of them are priced, and
     *  what each one's output declares. */
    plugins: PluginSpecs;
    /** The movement's pin: which of a plugin's outputs it gets (absent: the
     *  current language's). */
    languageVersion?: LanguageVersion;
  },
): PricedCalls {
  const { llm, files } = host;
  const { segmentId, ledger, plugins, languageVersion = CURRENT_LANGUAGE_VERSION } = run;
  return {
    client: { call: (input) => charged(ledger, (budget) => llm.client.call({ ...input, segmentId, budget })) },
    extractCall: {
      call: (input) => charged(ledger, (budget) => llm.extractCall.call({ ...input, segmentId, budget })),
    },
    transforms: {
      // A priced plugin is refused before it starts once the run has spent
      // its cap; anything it or the models it calls spend comes back as cost.
      invoke: async (input) => {
        const spec = pluginSpecNamed(plugins, input.plugin);
        if (spec?.priced === true) ledger.check();
        const answer = await charged(ledger, (budget) => llm.transforms.invoke({ ...input, segmentId, budget }));
        return withDeclaredFiles(answer, spec !== undefined ? pluginOutputUnder(spec, languageVersion) : undefined);
      },
    },
    arbitrateEntities: async (input) => {
      const { index, judgeUnavailable } = await charged(ledger, (budget) =>
        llm.arbitrateEntities({ ...input, segmentId, budget }),
      );
      return { index, ...(judgeUnavailable !== undefined ? { judgeUnavailable } : {}) };
    },
    // The host redeems a descriptor: the file crosses as its plain JSON, the
    // engine's mark staying on this side.
    resolveFileText: (input) =>
      charged(ledger, (budget) => files.resolveFileText({ ...input, file: { ...input.file }, segmentId, budget })),
  };
}
