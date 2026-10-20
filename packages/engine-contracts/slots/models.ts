// The models slot's methods (docs/contracts/models-slot.md): one model call,
// one answer — no streaming. The request is the host's models door's
// (`HostModelRequest`) with an output ceiling; the answer is the door's,
// priced by the module (`cost`, which the host adds to the run's spend), with
// the tokens it spent (`usage`, which a run's usage reports), both required.
// A module may publish its prices (`models.prices`), so a host can refuse a
// call its run cannot afford before making it.

import { z } from 'zod';

import { HostModelAnswer, HostModelRequest, WireModelUsage } from '../protocol';

export const MODELS_METHODS = ['models.call'] as const;

/** The optional method a module lists in its manifest when it publishes its prices. */
export const MODELS_PRICES_METHOD = 'models.prices';

export const ModelsCallRequest = HostModelRequest.extend({
  /** The extraction keyword's tiers reach `xhigh`; the door's own callers do not. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  /** The answer's output ceiling, in tokens; absent: the module's own. */
  maxTokens: z.number().int().positive().optional(),
});
export type ModelsCallRequestShape = z.infer<typeof ModelsCallRequest>;

export const ModelsCallAnswer = HostModelAnswer.extend({ usage: WireModelUsage });
export type ModelsCallAnswerShape = z.infer<typeof ModelsCallAnswer>;

/** Dollars per million tokens. A missing cache rate bills at the input rate. */
export const ModelPrice = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheCreation: z.number().nonnegative().optional(),
});
export type ModelPriceShape = z.infer<typeof ModelPrice>;

/** `models.prices`: the price of every model name the module answers
 *  `models.call` for, keyed by that name as a request writes it. A model
 *  priced at zero for both input and output is free: its answers may cost nothing. */
export const ModelsPricesAnswer = z.object({ prices: z.record(z.string(), ModelPrice) });
export type ModelsPricesAnswerShape = z.infer<typeof ModelsPricesAnswer>;

/** Whether a published price says the model costs nothing. */
export function isFreePrice(price: ModelPriceShape): boolean {
  return price.input === 0 && price.output === 0 && (price.cacheRead ?? 0) === 0 && (price.cacheCreation ?? 0) === 0;
}
