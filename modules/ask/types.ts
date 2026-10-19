// The ask vocabulary: the families, the answer types, the lattice states, and
// the record every host keeps for an ask. Data only, so a host's own surfaces
// (a link page, a list of open asks) can read it without the adapter.

import { z } from 'zod';

/** The adapter type the module answers to — the tag every saved movement's
 *  `ask()` resolves to. Never renamed. */
export const ASK_ADAPTER_TYPE = 'ask';

/** The ask families — each is a writable position on the adapter root. The
 *  family FIXES the answer's type (there is no runtime disagreement possible
 *  between the surface control and the stored answer — the founding incident,
 *  structurally gone).
 *
 *  `Choose` is one named option from `Options`; `Select` is a subset of them
 *  (possibly empty); `Form` is the record-level shape of the legacy composite
 *  ask — the author names `Fields` (untyped), the answer is one object with a
 *  value for every named field. There is no per-field typing and no independent
 *  sub-ask parking. */
export const ASK_FAMILIES = [
  'Check', 'Provide', 'Choose', 'Select', 'Review', 'Correct', 'Draft', 'Form',
] as const;
export type AskFamily = (typeof ASK_FAMILIES)[number];

export function isAskFamily(value: string): value is AskFamily {
  return (ASK_FAMILIES as readonly string[]).includes(value);
}

/** The answer types a `Provide` ask may declare. The other families fix their
 *  own answer shape, so `answerType` is meaningful only for `Provide`. */
export const ASK_ANSWER_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export type AskAnswerType = (typeof ASK_ANSWER_TYPES)[number];

export function isAskAnswerType(value: string): value is AskAnswerType {
  return (ASK_ANSWER_TYPES as readonly string[]).includes(value);
}

/** The lattice states. `open` is the only non-terminal one. */
export const ASK_STATES = ['open', 'answered', 'expired'] as const;
export type AskState = (typeof ASK_STATES)[number];

/** Tokens carry a stable prefix so a host's shared answer route can tell an
 *  ask token from anything else it answers by the token alone. */
export const ASK_TOKEN_PREFIX = 'ask_';

/** Caller-opaque passthrough, stored verbatim and echoed back — never parsed,
 *  and never identity, so there is deliberately no uniqueness surface over it.
 *  The fields below are what a movement's write records. */
export interface AskProvenance {
  movementId?: string;
  runId?: string;
  nodeId?: string;
  adapterType?: string;
}

/** One record offered to a `Correct` ask — a plain object of field name to
 *  current value, addressed by an ephemeralId stable for this ask's lifetime. */
export interface AskRowSpec {
  ephemeralId: string;
  fields: Record<string, unknown>;
}

const askRowSpecSchema = z.object({
  ephemeralId: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

/** An ask as the module keeps it in its host's kv (`ask:<id>`). Times are
 *  ISO-8601, so the record is the same JSON on every host. */
export const askRecordSchema = z.object({
  id: z.string().uuid(),
  family: z.enum(ASK_FAMILIES),
  answerType: z.enum(ASK_ANSWER_TYPES).nullable(),
  prompt: z.string(),
  detail: z.string().nullable(),
  /** Choose/Select: the offered options. Form: the named fields it collects.
   *  Immutable once written. */
  options: z.array(z.string()).nullable(),
  /** Correct only — the records offered for review (immutable). */
  rows: z.array(askRowSpecSchema).nullable(),
  state: z.enum(ASK_STATES),
  answer: z.unknown(),
  token: z.string(),
  tokenExpiresAt: z.string(),
  provenance: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
});

export type StoredAsk = z.infer<typeof askRecordSchema>;

/** A stored ask with the link its host answers it at. */
export interface AskRecord extends StoredAsk {
  family: AskFamily;
  /** The capability link the author delivers — the ONLY delivery affordance
   *  (the module renders nothing, sends nothing). */
  url: string;
}
