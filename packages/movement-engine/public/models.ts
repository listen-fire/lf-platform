// Models, their registry and per-environment map, the money a run spends on
// them (what a call cost is the model module's to say: @listen-fire/anthropic
// prices and calls Claude), the identity judge (the
// model-backed decision of whether two records are the same entity) and the
// uniqueness rules it arbitrates with, the model calls the engine makes (the
// extraction and transform call shapes, the batched extraction client and its
// model choice), and the embedding models and their destinations.

export * from '../lib/models/registry';
export * from '../lib/models/map';
export * from '../lib/models/google_account';
export * from '../lib/run_cost';
export * from '../lib/run_spend';
export * from '../services/identity_judge/judge';
export { claudeModelId } from '../services/movement_engine/ai_tiers';
export { metered, refusingPastBudget } from '../services/translation_graph/movement/metered';
export * from '../services/translation_graph/uniqueness';
export type {
  FileUnreadable,
  TransformInvocationResult,
  TransformInvokeInput,
} from '../services/movement_engine/extraction';
export type { ExtractCallLlmClient } from '../services/movement_engine/extraction_call';
export * from '../services/translation_graph/engine/batched_extraction/llm_call';
export * from '../services/translation_graph/engine/batched_extraction/model_choice';
export * from '../lib/models/embedding/destinations';
export * from '../lib/models/embedding/range';
