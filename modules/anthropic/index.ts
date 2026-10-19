// @lf/anthropic: the models slot's module for Claude. The client every model
// call goes through (chat, structured output, the tool loop, web chat), the
// chat seam a provider stands behind, Anthropic's API on a key the caller
// holds, the price table a call is billed from, and the engine's extraction
// and `AI()` clients built on the chat call. The engine names none of it: a
// shell hands the engine these clients through the models slot.

export {
  anthropicClient,
  defaultPageReader,
  meterAnthropicUsage,
  MAX_CHAT_CONTINUATIONS,
  StructuredOutputError,
  type AnthropicChatOptions,
  type AnthropicChatStructuredOptions,
  type AnthropicClient,
  type AnthropicToolLoopParams,
  type AnthropicUsageTally,
  type AnthropicWebChatOptions,
  type AnthropicWebChatReply,
  type ChatReply,
  type LlmUsage,
  type ModelAccess,
  type PageFetcher,
  type PageFetchResult,
  type PageReader,
  type SearchHit,
  type TurnEvent,
  type WebSearcher,
  type WebSearchResult,
  type WebToolEvent,
} from './client';
export type { AnthropicSystemBlock, AnthropicUserBlock } from './client';
export type { ChatCall, ChatCallFor, ChatProvider } from './chat';
export { anthropicKeyedChatProvider, type AnthropicKey } from './keyed_provider';
export { parseJson, parseJsonReply } from './parse_json';
export { costMicrodollars, priceFor, type Price, type TokenCounts } from './pricing';
export { makeAnthropicExtractCallClient, makeAnthropicLlmClient, type ModelClientOptions } from './llm_clients';
