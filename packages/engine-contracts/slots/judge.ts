// The judge slot's methods (docs/contracts/judge-slot.md): the identity
// question the engine's rules could not settle alone — which of a write's
// search candidates the asserted record IS — answered with the candidate's
// index, or null to create a new record. A judge that cannot be asked (its
// own call failed) says why in `judgeUnavailable`, so the write reads as
// "not asked", not as a considered decline.

import { z } from 'zod';

import { WireCostLine, WireUniquenessConstraints } from '../protocol';

export const JUDGE_METHODS = ['judge.arbitrate'] as const;

export const JudgeArbitrateRequest = z.object({
  asserted: z.record(z.string(), z.unknown()),
  /** The search's candidates, as the adapter answered them (each names its record). */
  candidates: z.array(z.record(z.string(), z.unknown())),
  recordType: z.string(),
  constraints: WireUniquenessConstraints,
  /** The asking run's language version: whether a blank key is a key. */
  languageVersion: z.number().int().positive(),
});
export type JudgeArbitrateRequestShape = z.infer<typeof JudgeArbitrateRequest>;

export const JudgeArbitrateAnswer = z.object({
  index: z.number().int().nonnegative().nullable(),
  judgeUnavailable: z.string().optional(),
  cost: z.array(WireCostLine).default([]),
});
export type JudgeArbitrateAnswerShape = z.infer<typeof JudgeArbitrateAnswer>;
