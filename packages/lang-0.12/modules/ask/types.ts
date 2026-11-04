// The ask vocabulary: the families, the answer types and the lattice states,
// as production's `@lf/ask` declared them at 0.12. The record a host keeps for
// an ask is the module's running half, which this package does not carry.

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
