// The ask adapter. An ORDINARY adapter that happens to hold the awaitable
// capability; its entire specialness is its record semantics. An author
// constructs `ask()` like any adapter and writes a question along a family
// edge —
//
//   asks = ask()
//   write asks-[:Check]-> { Prompt: "Ship it?" }
//
// Positions = FAMILIES (`Check`, `Provide`, `Choose`, `Select`, `Review`,
// `Correct`, `Draft`, `Form`). The family fixes the answer's type. Each written
// record exposes the author's immutable fields, a readable `Url` (the ONLY
// delivery affordance — the adapter renders nothing, sends nothing), a readable
// `State`, and a write-only `Cancelled` surface (`write a { Cancelled: true }`)
// that freezes the record to `expired`.
//
// The `Response` edge is an ORDINARY edge that happens to be AWAITABLE:
// readable and writable synchronously, with `await` the read that waits.
// Writing it — `write a-[:Response]-> { Answer: TRUE }` — is how an answer
// arrives from movement code, and the answer semantics are enforced at that
// write (`records.ts`). Reading it yields nothing until the request is
// answered. No root readability: a program cannot enumerate open asks.
//
// The records live in the host's kv. The host wakes a run parked on an ask
// when the ask settles; the adapter only answers what the record says.

import type {
  Adapter,
  AwaitableCapability,
  AwaitPoint,
  AwaitResolution,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';

import { singleParentLink, unsupportedAssociation } from 'movement-engine/public/adapter';
import { META_RECORD_TYPE, makeStablePosition, positionData } from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { uniformWalk } from 'module-kit/adapter/hop';
import { UPDATE_NOT_FOUND } from 'module-kit/adapter/not_found';

import {
  FAMILY_BLURB,
  FIELD,
  RESPONSE_ANSWER_FIELD,
  RESPONSE_EDGE_FIELD_ID,
  RESPONSE_EDGE_NAME,
  familyDescriptor,
  responseDescriptor,
  responseTypeFamily,
  responseTypeId,
} from './descriptors';
import { ASK_MANIFEST } from './manifest';
import { AskResponseRefused, answerAsk, cancelAsk, createAsk, getAsk, type AskRecords } from './records';
import {
  ASK_ADAPTER_TYPE,
  ASK_ANSWER_TYPES,
  ASK_FAMILIES,
  isAskAnswerType,
  isAskFamily,
  type AskAnswerType,
  type AskRowSpec,
} from './types';

export class AskAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = ASK_ADAPTER_TYPE;
  readonly supportedTriggers = ASK_MANIFEST.supportedTriggers;

  constructor(private readonly records: AskRecords) {
    super();
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // The four families — writable positions on the root. `readable: false`:
      // no root readability in v1, so a program can write an ask but never
      // enumerate open ones (AGREED, ruling 2026-07-28).
      ...ASK_FAMILIES.map((family) => ({
        typeId: family,
        displayName: family,
        scope: 'self-configured' as const,
        writable: true,
        readable: false,
      })),
      // Each family's own Response node — reached only by awaiting its edge.
      // Published so the resolver + describe know it; no root promise.
      ...ASK_FAMILIES.map((family) => ({
        typeId: responseTypeId(family),
        displayName: responseTypeId(family),
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      })),
    ];
  }

  /** The root: the four ways to ask, each landing on its family record. */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Ask',
    description:
      'Asking a person a question mid-run. Write along a family edge to raise an ' +
      'ask; there is nothing to list here — an ask is a one-shot, delivered by ' +
      'its link and answered once.',
    fields: [],
    references: ASK_FAMILIES.map((family) => ({
      fieldId: family,
      name: family,
      targetTypeId: family,
      cardinality: 'one' as const,
      direction: 'outgoing' as const,
      writable: true,
      // No enumeration of asks from the root (no root readability, v1).
      readable: false,
      description: FAMILY_BLURB[family],
    })),
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: ASK_ADAPTER_TYPE,
      at: position,
      root: AskAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    if (isAskFamily(typeId)) return familyDescriptor(typeId);
    const responseFamily = responseTypeFamily(typeId);
    if (responseFamily !== undefined) return responseDescriptor(responseFamily);
    return null;
  }

  /**
   * The READ side of the Response edge, synchronously (callback-primitive layer
   * 3). An unanswered — or cancelled — request yields NOTHING; an answered one
   * yields its Response record, the same landing `resolveAwait` hands the engine
   * when it wakes a parked run. `await` differs only in waiting for it.
   */
  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    // The natural edge name in, this adapter's own reference id out — the
    // standard traversal-read translation, so a name the descriptor doesn't
    // publish is the shared drift error rather than a bespoke one.
    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId !== RESPONSE_EDGE_FIELD_ID) {
      throw new Error(
        `AskAdapter.getRelated: '${input.fieldId}' is not an edge on an ask — the only one is '${RESPONSE_EDGE_NAME}'.`,
      );
    }
    if (input.direction !== 'outgoing') {
      throw new Error(
        `AskAdapter.getRelated: '${RESPONSE_EDGE_NAME}' is outgoing only — an answer is not enumerable from the other end.`,
      );
    }
    if (input.position.identity.kind !== 'stable') {
      throw new Error(
        `AskAdapter.getRelated: '${RESPONSE_EDGE_NAME}' is read off a written ask, which carries its identity; this position does not.`,
      );
    }
    const ask = await getAsk(this.records, input.position.identity.recordId);
    // Gone, still open, or cancelled — there is no answer to hand back. This is
    // the read half of `resolvesEmpty`, and the reason the landing's fields type
    // as possibly-absent.
    if (!ask || ask.state !== 'answered') return [];
    return [
      {
        position: makeStablePosition({
          adapterType: ASK_ADAPTER_TYPE,
          recordType: responseTypeId(ask.family),
          recordId: ask.id,
          data: { [RESPONSE_ANSWER_FIELD]: ask.answer },
        }),
      },
    ];
  }

  /**
   * Field reads off a written ask handle. The delivery `Url` and the writable
   * fields ride the write-result shape directly; `State` and the written fields
   * are read LIVE from the store here (so `State` reflects the current lattice
   * position, not a write-time snapshot). Falls back to the position's inline
   * data when the ask row is gone.
   */
  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== ASK_ADAPTER_TYPE) {
      throw new Error(
        `AskAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const field = input.fieldId;
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    const record =
      input.position.identity.kind === 'stable'
        ? await getAsk(this.records, input.position.identity.recordId)
        : null;

    // A Form's Response carries one property per declared field — the same
    // narrowing `askResponseDescriptorFor` types, resolved here so the promise is
    // real rather than a descriptor that reads null. `Answer` remains the one
    // stored carrier (`coerceForm` guarantees a value for every declared name);
    // these are views onto it, taken BEFORE the shared switch so a form field
    // called `State` reads the answer, never the ask's lattice position.
    const positionType = input.position.recordType;
    if (
      positionType !== null &&
      responseTypeFamily(positionType) === 'Form' &&
      field !== RESPONSE_ANSWER_FIELD
    ) {
      const answered =
        record?.state === 'answered' ? record.answer : data[RESPONSE_ANSWER_FIELD];
      if (answered !== null && typeof answered === 'object' && !Array.isArray(answered)) {
        return (answered as Record<string, unknown>)[field] ?? null;
      }
      return null;
    }

    switch (field) {
      case RESPONSE_ANSWER_FIELD:
        // Read off a Response position — live from the store when the position
        // is the ask's own (a synchronous read of the edge), from the inline
        // landing when the engine bound one at a resolved `await`.
        return record?.state === 'answered' ? record.answer : (data[RESPONSE_ANSWER_FIELD] ?? null);
      case FIELD.url:
        return record?.url ?? data[FIELD.url] ?? null;
      case FIELD.state:
        return record?.state ?? data[FIELD.state] ?? null;
      case FIELD.prompt:
        return record?.prompt ?? data[FIELD.prompt] ?? null;
      case FIELD.detail:
        return record?.detail ?? data[FIELD.detail] ?? null;
      case FIELD.answerType:
        return record?.answerType ?? data[FIELD.answerType] ?? null;
      case FIELD.options:
        return record?.options ?? data[FIELD.options] ?? null;
      case FIELD.rows:
        return record?.rows ?? data[FIELD.rows] ?? null;
      case FIELD.fields:
        // Form's `Fields` rides the SAME store column as Options — a
        // different displayName over one generic "offered strings" slot.
        return record?.options ?? data[FIELD.fields] ?? null;
      default:
        return data[field] ?? null;
    }
  }

  /**
   * ANSWERING — `write a-[:Response]-> { Answer: … }` (callback-primitive layer
   * 3). Ordinary movement code, so a callback body needs nothing special; the
   * answer semantics are the store's lattice transition, reached through the one
   * `writeAskResponse` every other door also goes through.
   *
   * A refusal (closed request, unfit answer, vanished record) is a THROW,
   * because a write has no other failure channel — but a typed one carrying the
   * outcome, so a caller acks from `.outcome.kind` rather than a message match.
   */
  private async writeResponse(input: WriteInput): Promise<WriteResult> {
    const parent = singleParentLink(input);
    if (parent === undefined || parent.edgeName !== RESPONSE_EDGE_NAME) {
      throw new Error(
        `AskAdapter.createRecord(${input.recordType}): an answer is written along its own request's ` +
          "edge — `write a-[:Response]-> { Answer: … }`; there is no other way to reach one.",
      );
    }

    const outcome = await answerAsk(this.records, {
      id: parent.externalId,
      raw: input.fields[RESPONSE_ANSWER_FIELD],
    });
    if (outcome.kind !== 'settled') throw new AskResponseRefused(outcome);

    // The ask's OWN family names the landing — the record is the truth about
    // what was asked, not the type the write site inferred.
    return {
      adapterType: ASK_ADAPTER_TYPE,
      externalId: outcome.ask.id,
      recordType: responseTypeId(outcome.ask.family),
      data: { [RESPONSE_ANSWER_FIELD]: outcome.ask.answer },
    };
  }

  async createRecord(input: WriteInput): Promise<WriteResult> {
    if (responseTypeFamily(input.recordType) !== undefined) return this.writeResponse(input);
    const family = input.recordType;
    if (!isAskFamily(family)) {
      throw new Error(
        `AskAdapter.createRecord: '${family}' is not an ask family (${ASK_FAMILIES.join(', ')}).`,
      );
    }
    const fields = input.fields;
    const prompt = readString(fields[FIELD.prompt]);
    if (prompt === undefined || prompt.trim() === '') {
      throw new Error(`AskAdapter.createRecord(${family}): 'Prompt' is required.`);
    }
    const detail = readString(fields[FIELD.detail]) ?? null;

    let answerType: AskAnswerType | null = null;
    if (family === 'Provide') {
      const raw = readString(fields[FIELD.answerType]);
      if (raw === undefined || !isAskAnswerType(raw)) {
        throw new Error(
          `AskAdapter.createRecord(Provide): 'Answer Type' must be one of ${ASK_ANSWER_TYPES.join(', ')}.`,
        );
      }
      answerType = raw;
    }

    let options: string[] | null = null;
    if (family === 'Choose' || family === 'Select') {
      options = readStringList(fields[FIELD.options]);
      if (options.length === 0) {
        throw new Error(`AskAdapter.createRecord(${family}): 'Options' must list at least one choice.`);
      }
    }

    let formFields: string[] | null = null;
    if (family === 'Form') {
      formFields = readStringList(fields[FIELD.fields]);
      if (formFields.length === 0) {
        throw new Error(`AskAdapter.createRecord(Form): 'Fields' must name at least one field to collect.`);
      }
      // Form's declared field names ride the SAME store column as
      // Choose/Select's options — both are "a list of offered strings", just
      // answered differently (one chosen vs. one value per name).
      options = formFields;
    }

    let rows: AskRowSpec[] | null = null;
    if (family === 'Correct') {
      const raw = readJsonRecordList(fields[FIELD.rows]);
      if (raw.length === 0) {
        throw new Error(`AskAdapter.createRecord(Correct): 'Rows' must list at least one record to review.`);
      }
      rows = raw.map((r, i) => ({ ephemeralId: `row-${i}`, fields: r }));
    }

    const ask = await createAsk(this.records, {
      family,
      prompt,
      detail,
      answerType,
      options,
      rows,
      provenance: provenanceFrom(input),
    });

    return {
      adapterType: ASK_ADAPTER_TYPE,
      externalId: ask.id,
      recordType: family,
      url: ask.url,
      data: {
        [FIELD.url]: ask.url,
        [FIELD.state]: ask.state,
        [FIELD.prompt]: ask.prompt,
        [FIELD.detail]: ask.detail,
        ...(answerType !== null ? { [FIELD.answerType]: answerType } : {}),
        ...(family !== 'Form' && options !== null ? { [FIELD.options]: options } : {}),
        ...(formFields !== null ? { [FIELD.fields]: formFields } : {}),
        ...(rows !== null ? { [FIELD.rows]: rows } : {}),
      },
    };
  }

  /**
   * The cancellation surface — `write a { Cancelled: true }`. Freezes an open
   * ask to `expired`; rejects OBSERVABLY on a settled record (F17 — one
   * consistent outcome). A missing row returns the typed not-found signal so the
   * engine's bind self-heal behaves; a non-cancel update is an error (Cancelled
   * is the only writable surface after create).
   */
  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    const family = input.recordType;
    if (!isAskFamily(family)) {
      throw new Error(
        `AskAdapter.updateRecord: '${family}' is not an ask family (${ASK_FAMILIES.join(', ')}).`,
      );
    }
    const cancelled = input.fields[FIELD.cancelled];
    if (cancelled !== true && cancelled !== 'true') {
      throw new Error(
        `AskAdapter.updateRecord(${family}): the only supported update is { Cancelled: true }.`,
      );
    }

    const outcome = await cancelAsk(this.records, { id: input.externalId });
    if (outcome.kind === 'not_found') return UPDATE_NOT_FOUND;
    if (outcome.kind !== 'settled') {
      // Settled before this cancel — reject observably.
      throw new Error(
        `AskAdapter.updateRecord(${family}): cannot cancel — this ask has already ` +
          `${outcome.ask.state === 'answered' ? 'been answered' : 'expired'}.`,
      );
    }
    return {
      adapterType: ASK_ADAPTER_TYPE,
      externalId: outcome.ask.id,
      recordType: family,
      url: outcome.ask.url,
      data: {
        [FIELD.state]: outcome.ask.state,
        [FIELD.url]: outcome.ask.url,
      },
      // An ask is raised, never re-homed: cancelling one is the only update,
      // and it attaches nothing.
      association: unsupportedAssociation(input),
    };
  }

  /**
   * Asks are receipts, not editable records — there is deliberately no delete
   * surface (RULED). Deleting one would orphan its `adapter_await` correlation
   * (and any run still parked on its Response edge) instead of settling it; an
   * open ask that no longer belongs is cancelled (`write a { Cancelled: true }`
   * → `updateRecord`, which resolves any awaiter EMPTY), never removed. This
   * override exists only to name the reason — `BaseAdapter.deleteRecord`
   * already throws, but with the generic "not a write target" message, which
   * would read as a gap to fill rather than a closed door.
   */
  async deleteRecord(_input: DeleteInput): Promise<DeleteResult> {
    throw new Error(
      'AskAdapter.deleteRecord: ask records are receipts and cannot be deleted — cancel an ' +
        'open ask instead (write a { Cancelled: true }).',
    );
  }

  /**
   * The AWAITABLE capability (asks-as-adapter §A) — the engine consumption of
   * the `Response` edge's `awaitable`/`resolvesEmpty` flags. A pending ask
   * correlates on its own id; the state lattice IS the resolution:
   *   - open      → `pending`  (park, armed, keyed by the ask id)
   *   - answered  → `landed`   (the Response node carrying the typed answer)
   *   - expired   → `empty`    (resolvesEmpty — an explicit cancel settles the
   *                             awaiter empty immediately, F6)
   * The adapter reports what has arrived; the engine applies the await's WHERE
   * and owns the park/resume. F17 — the lattice's optimistic guards already
   * serialise cancel-vs-answer into one consistent record state.
   */
  readonly awaitable: AwaitableCapability = {
    resolveAwait: async (point: AwaitPoint): Promise<AwaitResolution> => {
      if (point.edge !== RESPONSE_EDGE_NAME) {
        // The only awaitable edge is Response; anything else is a caller bug.
        throw new Error(`AskAdapter.resolveAwait: '${point.edge}' is not an awaitable edge.`);
      }
      const ask = await getAsk(this.records, point.recordId);
      if (!ask) {
        // The ask row is gone (deleted). Nothing will ever resolve it — settle
        // empty so the awaiter completes rather than parking forever.
        return { status: 'empty' };
      }
      switch (ask.state) {
        case 'open':
          return { status: 'pending', correlationKey: ask.id };
        case 'expired':
          return { status: 'empty' };
        case 'answered':
          return {
            status: 'landed',
            correlationKey: ask.id,
            landings: [
              {
                recordId: ask.id,
                // The landing's TYPE is the ask's OWN family's Response type —
                // the engine binds this as the position's recordType, so a
                // read of `r.Answer` dispatches to the right descriptor.
                recordType: responseTypeId(ask.family),
                fields: { [RESPONSE_ANSWER_FIELD]: ask.answer },
              },
            ],
          };
      }
    },
  };
}

// ── Field-value coercion off the write body ─────────────────────────────────

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => readString(v)).filter((v): v is string => v !== undefined && v.trim() !== '');
  }
  const single = readString(value);
  return single !== undefined && single.trim() !== '' ? [single] : [];
}

/** `Correct`'s `Rows` write value — an array of plain objects (a record's
 *  field name → current value each). Non-object entries are dropped rather
 *  than rejected wholesale (tolerant of a stray null/scalar in the array). */
function readJsonRecordList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

/** Movement / run / node ids as INFO — never identity (F16). Pulled from the
 *  write's mutation context. */
function provenanceFrom(input: WriteInput): Record<string, string> {
  const source = input.mutationContext.source;
  const p: Record<string, string> = {};
  if (source.translationGraphId !== undefined) p.movementId = source.translationGraphId;
  if (source.translationGraphNodeId !== undefined) p.nodeId = source.translationGraphNodeId;
  if (source.adapterType !== undefined) p.adapterType = source.adapterType;
  return p;
}
