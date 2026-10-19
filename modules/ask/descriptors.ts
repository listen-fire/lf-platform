// The ask schema: each family's record, each family's Response, and the
// per-ask narrowing of a Response that the ask's own literals fix. Data and
// pure functions only — the adapter describes with these, and a host's
// checker narrows with `askResponseDescriptorFor` without loading it.

import type {
  SchemaFieldDescriptor,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from 'movement-engine/public/catalog';

import { ASK_ANSWER_TYPES, ASK_FAMILIES, isAskAnswerType, isAskFamily, type AskAnswerType, type AskFamily } from './types';

/** The awaitable edge's name — literal in both `responseEdge()` and
 *  `resolveAwait`'s dispatch, so it's one constant rather than two agreeing
 *  string literals. Unlike the LANDING type (per-family, below), the edge
 *  itself is the same name on every family — `await x-[:Response]->` reads
 *  the same regardless of which family `x` is. */
export const RESPONSE_EDGE_NAME = 'Response';

/** The same edge's internal reference id — what the read-side name resolver
 *  translates `Response` INTO, so `getRelated` compares against one constant
 *  rather than re-stating the descriptor's `fieldId` as a literal. */
export const RESPONSE_EDGE_FIELD_ID = 'response';

/** The per-family Response type id — where a resolution along the awaitable
 *  `Response` edge lands. Each family gets its OWN type (chunk A, asks-as-
 *  adapter layer 5): the answer's real shape is the family's, so the landing
 *  type must be too — `Check Response` isn't `Choose Response`. Published so
 *  the name resolver + `describe` know each type; reached ONLY by awaiting the
 *  edge (never a root read). */
export function responseTypeId(family: AskFamily): string {
  return `${family} Response`;
}

/** The inverse — which family's Response type a written/traversed type names.
 *  A COMPARISON against the eight names, never a parse of the string. */
export function responseTypeFamily(typeId: string): AskFamily | undefined {
  return ASK_FAMILIES.find((family) => responseTypeId(family) === typeId);
}

/** The Response record's single field — the typed answer. ONE constant so the
 *  descriptor's `fieldId`/`displayName`, the landing dict the engine binds, and
 *  `getFieldValue`'s dispatch cannot drift: an author reads the DECLARED name
 *  (`got.Answer`) and the landing is keyed by that same name end-to-end. (The
 *  founding incident was surface-vs-store disagreement; a lowercase `answer`
 *  landing under an `Answer` descriptor was the same class of bug in miniature.) */
export const RESPONSE_ANSWER_FIELD = 'Answer';

/** Field display names — the natural names an author writes. Internal ids
 *  match (the adapter routes on the family + these names directly). */
export const FIELD = {
  prompt: 'Prompt',
  detail: 'Detail',
  answerType: 'Answer Type',
  options: 'Options',
  rows: 'Rows',
  fields: 'Fields',
  url: 'Url',
  state: 'State',
  cancelled: 'Cancelled',
} as const;

// ── Field / descriptor helpers ─────────────────────────────────────────────

function commonWrittenFields(): SchemaFieldDescriptor[] {
  return [
    {
      fieldId: FIELD.prompt, displayName: FIELD.prompt, kind: 'string',
      writable: true, required: true,
      description: 'The question to put to the person (immutable once written).',
    },
    {
      fieldId: FIELD.detail, displayName: FIELD.detail, kind: 'string',
      writable: true, required: false,
      description: 'Optional elaboration shown under the question.',
    },
  ];
}

/** The fields every family's record exposes once written — the delivery link,
 *  the live state, and the write-only cancellation surface. */
function recordSurfaceFields(): SchemaFieldDescriptor[] {
  return [
    {
      fieldId: FIELD.url, displayName: FIELD.url, kind: 'string',
      writable: false, required: false,
      description: 'The private link to deliver — the only way a person answers this ask.',
    },
    {
      fieldId: FIELD.state, displayName: FIELD.state, kind: 'enum',
      writable: false, required: false, enumValues: ['open', 'answered', 'expired'],
      description: 'Where the ask sits in its lattice: open, answered, or expired.',
    },
    {
      fieldId: FIELD.cancelled, displayName: FIELD.cancelled, kind: 'boolean',
      writable: true, readable: false, required: false,
      description:
        'Write `{ Cancelled: true }` to expire an open ask. Rejected once the ask ' +
        'has settled (answered or already expired).',
    },
  ];
}

/**
 * The `Response` edge — the whole point of the ask model, and an ORDINARY edge
 * in every direction (callback-primitive layer 3):
 *
 *  - **writable**: the answer arrives as a write (`write a-[:Response]-> {
 *    Answer: TRUE }`) from anywhere movement code runs, a callback body
 *    included. Every other door is a wrapper over that same write.
 *  - **readable**: an unanswered request reads EMPTY; an answered one reads its
 *    Response record. `readable: false` used to make a bare read observably
 *    refused, which was the right call while `await` was the ONLY way in — now
 *    it would be a capability we simply declined to publish.
 *  - **awaitable**: `await` is demoted to "the read that waits" — the same edge,
 *    read with wait-until-at-least-one-exists behaviour. `resolvesEmpty` says an
 *    explicit cancel resolves awaiters EMPTY rather than parking them forever.
 *
 * Targets the FAMILY's own Response type — every family shares the edge's name
 * (`Response`) but not its landing type.
 */
function responseEdge(family: AskFamily): SchemaReferenceDescriptor {
  return {
    fieldId: RESPONSE_EDGE_FIELD_ID,
    name: RESPONSE_EDGE_NAME,
    targetTypeId: responseTypeId(family),
    cardinality: 'one',
    direction: 'outgoing',
    awaitable: true,
    // Answering or cancelling an ask queues the wake for the run parked on it
    // (the answer and cancel doors), with the closed sweep behind both — the
    // wake is delivered, so an await here needs no cadence.
    watchable: true,
    resolvesEmpty: true,
    readable: true,
    writable: true,
    // Answers are read back in the order they landed — the store appends and
    // the read hands that back (R2: an await landing is arrival-ordered).
    sequenced: 'arrival',
    ...(RESPONSE_GENERIC_OVER[family] !== undefined
      ? { genericOver: RESPONSE_GENERIC_OVER[family] }
      : {}),
    description:
      "The person's answer. Read it to see whether one has arrived yet, `await` it " +
      'to wait for one, or WRITE it to record one.',
  };
}

/**
 * The families whose answer type is decided BY THE ASK ITSELF, and the body
 * field that decides it (chunk B). `Choose`/`Select` answer within the very
 * `Options` they offered — nothing weaker is the truth — and `Provide` answers
 * the scalar its `Answer Type` names.
 *
 * The three `onNonLiteral` answers are three different facts, one per family:
 *
 *  - `Answer Type` is `'error'` because `createRecord` already refuses a
 *    non-literal (it must be one of `ASK_ANSWER_TYPES`), so a computed one fails
 *    at run time either way and the author would rather hear it now.
 *  - `Options` says NOTHING: options built from a query are a normal thing to
 *    write, and the answer is then honestly plain text — the base type was the
 *    whole promise, and it is kept.
 *  - `Fields` is `'warn'`. `Form`'s literals fix the landing's SHAPE rather than
 *    its scalar — a form declaring `["Budget","Timeline"]` answers a node
 *    carrying a `Budget` and a `Timeline` property, which needs no record
 *    FieldType (the old objection) because the structure lives on the NODE.
 *    Computed names run fine, so this is no error; but the author has just
 *    traded readable fields for one opaque object, and trading in silence is how
 *    a guarantee disappears.
 *
 * Everything else (`Check`, `Review`, `Correct`, `Draft`) has one answer type
 * per family and nothing to be generic over.
 */
const RESPONSE_GENERIC_OVER: Partial<
  Record<AskFamily, { field: string; onNonLiteral?: 'error' | 'warn' }>
> = {
  Choose: { field: FIELD.options },
  Select: { field: FIELD.options },
  Provide: { field: FIELD.answerType, onNonLiteral: 'error' },
  Form: { field: FIELD.fields, onNonLiteral: 'warn' },
};

/** Per-family extra writable fields — Provide names its answer type,
 *  Choose/Select name their options, Correct names the rows to review, Form
 *  names the fields it collects; Check, Review, and Draft add nothing. */
function familyExtraFields(family: AskFamily): SchemaFieldDescriptor[] {
  if (family === 'Provide') {
    return [{
      fieldId: FIELD.answerType, displayName: FIELD.answerType, kind: 'enum',
      writable: true, required: true, enumValues: [...ASK_ANSWER_TYPES],
      description: 'The type of value to collect: text, number, date, or boolean.',
    }];
  }
  if (family === 'Choose') {
    return [{
      fieldId: FIELD.options, displayName: FIELD.options, kind: 'string',
      cardinality: 'many', writable: true, required: true,
      description: 'The options to choose from — the answer is exactly one of these.',
    }];
  }
  if (family === 'Select') {
    return [{
      fieldId: FIELD.options, displayName: FIELD.options, kind: 'string',
      cardinality: 'many', writable: true, required: true,
      description: 'The options to choose from — the answer is the subset picked (possibly none).',
    }];
  }
  if (family === 'Correct') {
    return [{
      fieldId: FIELD.rows, displayName: FIELD.rows, kind: 'json',
      cardinality: 'many', writable: true, required: true,
      description:
        'The records to review — each a plain object of field name to current ' +
        'value. The answer reports which rows changed and which were dropped.',
    }];
  }
  if (family === 'Form') {
    return [{
      fieldId: FIELD.fields, displayName: FIELD.fields, kind: 'string',
      cardinality: 'many', writable: true, required: true,
      description: 'The named fields this form collects — the answer supplies a value for every one.',
    }];
  }
  return [];
}

export const FAMILY_BLURB: Record<AskFamily, string> = {
  Check: 'A yes/no decision — the answer is a boolean.',
  Provide: 'A typed value the person supplies (text, number, date, or boolean).',
  Choose: 'One named option chosen from a supplied list.',
  Select: 'A subset of a supplied list, possibly none.',
  Review: 'An awareness prompt — the answer is an acknowledgement.',
  Correct: 'Editable records to review — the answer is which rows changed and which were dropped.',
  Draft: 'A structured artifact the person composes — the answer is the drafted shape.',
  Form: 'Several named fields answered together as one unit.',
};

export function familyDescriptor(family: AskFamily): SchemaTypeDescriptor {
  return {
    typeId: family,
    displayName: family,
    description: FAMILY_BLURB[family],
    fields: [
      ...commonWrittenFields(),
      ...familyExtraFields(family),
      ...recordSurfaceFields(),
    ],
    references: [responseEdge(family)],
  };
}

/**
 * Each family's `Answer` field, straight from `coerceAnswer` (store.ts) — the
 * runtime truth this descriptor used to lie about. This is the BASE type per
 * family: what an ask of this family answers when the construction site tells
 * us nothing more. An ask that DID (literal `Options`, a literal `Answer Type`)
 * narrows it further through `askResponseDescriptorFor` below — the base is
 * what a computed-options ask honestly gets.
 */
const ASK_ANSWER_SPEC: Record<AskFamily, Pick<SchemaFieldDescriptor, 'kind' | 'cardinality'> & { description: string }> = {
  Check: {
    kind: 'boolean',
    description: '`true` if they approved, `false` if they declined.',
  },
  Choose: {
    kind: 'string',
    description:
      'The option they chose — one of the offered `Options` (typed as those exact options when the ask lists them literally).',
  },
  Select: {
    kind: 'string',
    cardinality: 'many',
    description:
      'The subset of `Options` they chose, possibly empty (typed as those exact options when the ask lists them literally).',
  },
  Review: {
    kind: 'string',
    description: "An acknowledgement (`'ack'`) — Review carries no other answer shape.",
  },
  Provide: {
    kind: 'string',
    description:
      'The value they supplied, typed by the declared `Answer Type` (text/number/date/boolean).',
  },
  Correct: {
    kind: 'json',
    description:
      '`{ rows, dropped }` — the edited rows and the ids of any they dropped, as one structured object.',
  },
  Draft: {
    kind: 'json',
    description: 'The structured artifact they composed.',
  },
  Form: {
    kind: 'json',
    description:
      'One object carrying a value for every named `Field` (when the ask lists ' +
      'its `Fields` literally, each is also a property of its own — read ' +
      '`` r.`Budget` `` rather than digging into this object).',
  },
};

/**
 * The per-family Response type — where a read, an `await` or a WRITE of the
 * Response edge lands.
 *
 * `Answer` is writable, and that one flag is the whole write side: the same
 * per-family kind the read promises is what the checker holds a write body to,
 * so `Answer: "maybe"` on a `Check` is a type error at the write for exactly the
 * reason it would be a type error at the read. `required` everywhere but
 * `Review`, whose answer IS the acknowledgement and carries no value.
 */
export function responseDescriptor(family: AskFamily): SchemaTypeDescriptor {
  const typeId = responseTypeId(family);
  const answer = ASK_ANSWER_SPEC[family];
  return {
    typeId,
    displayName: typeId,
    description: `The answer to a ${family} ask — read it, await it, or write it to answer.`,
    fields: [
      {
        fieldId: RESPONSE_ANSWER_FIELD, displayName: RESPONSE_ANSWER_FIELD, kind: answer.kind,
        ...(answer.cardinality !== undefined ? { cardinality: answer.cardinality } : {}),
        writable: true, required: family !== 'Review',
        description: answer.description,
      },
    ],
    references: [],
  };
}

/** `Provide`'s `Answer Type` literal → the kind the answer actually is. The two
 *  vocabularies are separate on purpose (`text` is the author-facing word for
 *  the descriptor's `string`), so the mapping is written out rather than
 *  assumed — and being exhaustive over `AskAnswerType`, adding an answer type
 *  without deciding its kind is a compile error, not a silent `text`. */
const PROVIDE_ANSWER_KIND: Record<AskAnswerType, SchemaFieldDescriptor['kind']> = {
  text: 'string',
  number: 'number',
  date: 'date',
  boolean: 'boolean',
};

/**
 * The Response type ONE ask's own construction literals fix — the per-instance
 * narrowing of `responseDescriptor` (asks-as-adapter layer 5, chunk B).
 *
 * THE TYPE IS ITS DERIVATION: two `Choose` asks offering the same options in
 * the same order have the same response type, so this is a pure function of
 * (family, values) with no identity of its own. The host's pre-pass grafts the
 * result into a copy of the instance schema under `genericLandingKey`, and the
 * checker looks it up — nothing here reaches the runtime, which already returns
 * the right values (`coerceAnswer`) and needs no second copy of the type.
 *
 * `Choose` closes the answer door to exactly what was offered (an enum, not
 * "text that happens to be one of these"); `Select` inherits `many` from the
 * base, so the same override reads `list<enum>`. `Form` is the one that widens
 * the node rather than the scalar: one READ-ONLY text property per declared
 * field name, which is exactly the shape `coerceForm` already enforces (one
 * object, a value for every name, no more and no less, every value text). `null`
 * for a family with nothing to be generic over, or values that name nothing real
 * — the base type stands, which is the honest answer when we can't see further.
 */
export function askResponseDescriptorFor(input: {
  family: string;
  values: readonly string[];
}): SchemaTypeDescriptor | null {
  const { family, values } = input;
  if (!isAskFamily(family) || values.length === 0) return null;
  const base = responseDescriptor(family);
  const answer = base.fields.find((f) => f.fieldId === RESPONSE_ANSWER_FIELD);
  if (answer === undefined) return null;

  if (family === 'Choose' || family === 'Select') {
    return {
      ...base,
      fields: [{ ...answer, kind: 'enum', enumValues: [...values] }],
    };
  }
  if (family === 'Provide') {
    const [declared] = values;
    // A typo'd / unknown answer type is MOV_ENUM_UNKNOWN_VALUE's to report off
    // the field's own enum — synthesizing nothing here leaves the base type and
    // exactly one diagnostic.
    if (values.length !== 1 || declared === undefined || !isAskAnswerType(declared)) return null;
    return {
      ...base,
      fields: [{ ...answer, kind: PROVIDE_ANSWER_KIND[declared] }],
    };
  }
  if (family === 'Form') {
    // `Answer` STAYS — it is the whole object the runtime stores, and the only
    // field a `write a-[:Response]-> { … }` can set (`writeResponse` answers
    // through it), so removing it would make a literal-Fields form unanswerable
    // from movement code and break every existing `a.Answer` read.
    const fields = new Map<string, SchemaFieldDescriptor>([[RESPONSE_ANSWER_FIELD, answer]]);
    for (const name of values) {
      // First occurrence wins, and a field named `Answer` never displaces the
      // object itself — one name, one meaning. Values are text because that is
      // all `coerceForm` promises; typed form fields are a separate change.
      if (fields.has(name)) continue;
      fields.set(name, {
        fieldId: name, displayName: name, kind: 'string',
        writable: false, required: false,
        description: `The answer given for '${name}'.`,
      });
    }
    return { ...base, fields: [...fields.values()] };
  }
  return null;
}

