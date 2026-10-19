// The models slot's methods (docs/contracts/models-slot.md): one model call,
// one answer — no streaming. The request is the host's models door's
// (`HostModelRequest`) with an output ceiling; the answer is the door's,
// priced by the module (`cost`, which the host adds to the run's spend), with
// the tokens it spent (`usage`, which a run's usage reports), both required.

import { z } from 'zod';

import { HostModelAnswer, HostModelRequest, WireModelUsage } from '../protocol';

export const MODELS_METHODS = ['models.call'] as const;

export const ModelsCallRequest = HostModelRequest.extend({
  /** The answer's output ceiling, in tokens; absent: the module's own. */
  maxTokens: z.number().int().positive().optional(),
});
export type ModelsCallRequestShape = z.infer<typeof ModelsCallRequest>;

export const ModelsCallAnswer = HostModelAnswer.extend({ usage: WireModelUsage });
export type ModelsCallAnswerShape = z.infer<typeof ModelsCallAnswer>;
