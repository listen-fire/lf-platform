// The answer semantics: what each family accepts as an answer, and the value
// it keeps. The family IS the type declaration — this is where "the surface
// control and the stored answer can never disagree" is enforced, for every
// door an answer arrives through.

import type { AskAnswerType, AskRowSpec, StoredAsk } from './types';

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Coerce + validate a raw answer against the ask's family (and, for Provide,
 *  its declared answer type). The family IS the type declaration — this is
 *  where "the surface control and the stored answer can never disagree" is
 *  enforced until the checker parameterizes `Provide<T>` (a later chunk). */
export function coerceAnswer(ask: Pick<StoredAsk, 'family' | 'options' | 'answerType' | 'rows'>, raw: unknown): CoerceResult {
  switch (ask.family) {
    case 'Check':
      return coerceBoolean(raw);
    case 'Review':
      // Awareness — any submission is an acknowledgement.
      return { ok: true, value: 'ack' };
    case 'Choose':
      return coerceChoice(ask.options ?? [], raw);
    case 'Select':
      return coerceSelectMany(ask.options ?? [], raw);
    case 'Provide':
      return coerceProvide(ask.answerType ?? 'text', raw);
    case 'Correct':
      return coerceCorrect(ask.rows ?? [], raw);
    case 'Draft':
      return coerceDraft(raw);
    case 'Form':
      return coerceForm(ask.options ?? [], raw);
  }
}

function coerceBoolean(raw: unknown): CoerceResult {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false, error: 'expected a yes/no answer' };
}

/** `Choose` — exactly one of the offered options. */
function coerceChoice(options: string[], raw: unknown): CoerceResult {
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (typeof value !== 'string' || !options.includes(value)) {
    return { ok: false, error: 'answer must be one of the offered options' };
  }
  return { ok: true, value };
}

/** `Select` — a SUBSET of the offered options, possibly empty. Mirrors the
 *  platform link page's checklist control:
 *  a hidden empty field makes an empty selection submittable ("the engine
 *  drops empty ids"), so blank/empty entries are filtered rather than
 *  rejected, and "none of these" is a valid answer — no minimum-1 rule. */
function coerceSelectMany(options: string[], raw: unknown): CoerceResult {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const chosen: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') continue; // the hidden empty field
    if (!options.includes(item)) {
      return { ok: false, error: `'${item}' is not one of the offered options` };
    }
    if (!chosen.includes(item)) chosen.push(item);
  }
  return { ok: true, value: chosen };
}

function coerceProvide(answerType: AskAnswerType, raw: unknown): CoerceResult {
  switch (answerType) {
    case 'boolean':
      return coerceBoolean(raw);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
      return { ok: true, value: n };
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s === '' || Number.isNaN(new Date(s).getTime())) {
        return { ok: false, error: 'expected a date' };
      }
      return { ok: true, value: s };
    }
    case 'text': {
      const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
      if (s.trim() === '') return { ok: false, error: 'an answer is required' };
      return { ok: true, value: s };
    }
  }
}

/** `Correct` — the answer is `{ rows, dropped }` (the web/link editable-table
 *  control's own payload, the platform link page's): the
 *  rows with edited fields, and the ephemeralIds of rows the person dropped.
 *  Every referenced ephemeralId must be one this ask actually offered — an
 *  unknown id is rejected observably rather than silently accepted or
 *  dropped, the same "surface and store can never disagree" enforcement as
 *  every other family. */
function coerceCorrect(offered: AskRowSpec[], raw: unknown): CoerceResult {
  const known = new Set(offered.map((r) => r.ephemeralId));
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'expected { rows, dropped }' };
  }
  const rec = raw as Record<string, unknown>;
  const rowsIn = Array.isArray(rec.rows) ? rec.rows : [];
  const droppedIn = Array.isArray(rec.dropped) ? rec.dropped : [];

  const rows: AskRowSpec[] = [];
  for (const item of rowsIn) {
    if (item === null || typeof item !== 'object') return { ok: false, error: 'malformed row edit' };
    const r = item as Record<string, unknown>;
    if (typeof r.ephemeralId !== 'string' || !known.has(r.ephemeralId)) {
      return { ok: false, error: `unknown row '${String(r.ephemeralId)}'` };
    }
    const fields = r.fields !== null && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : {};
    rows.push({ ephemeralId: r.ephemeralId, fields });
  }

  const dropped: string[] = [];
  for (const id of droppedIn) {
    if (typeof id !== 'string' || !known.has(id)) {
      return { ok: false, error: `unknown row '${String(id)}'` };
    }
    dropped.push(id);
  }

  return { ok: true, value: { rows, dropped } };
}

/** `Draft` — the answer is the drafted shape itself: a structured object the
 *  person composed. No per-field typing (the legacy `Shape` parameter is a
 *  movement-lang type the ask record has no way to check against) — only
 *  that it IS a structured record, not a scalar or array. */
function coerceDraft(raw: unknown): CoerceResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'expected a structured draft' };
  }
  return { ok: true, value: raw };
}

/** `Form` — the record-level shape of the legacy composite ask (3i R5):
 *  every declared field answered together as one object, no more and no
 *  less. There is no per-field typing or independent sub-ask parking (the
 *  real composite engine — one park across N typed parts — was never built
 *  upstream either; 8_build_order.md: "parse-rejected, deferred"). */
function coerceForm(fields: string[], raw: unknown): CoerceResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `expected an answer for each of: ${fields.join(', ')}` };
  }
  const rec = raw as Record<string, unknown>;
  const missing = fields.filter((f) => !(f in rec));
  if (missing.length > 0) return { ok: false, error: `missing answers for: ${missing.join(', ')}` };
  const extra = Object.keys(rec).filter((k) => !fields.includes(k));
  if (extra.length > 0) return { ok: false, error: `unexpected fields: ${extra.join(', ')}` };

  const value: Record<string, unknown> = {};
  for (const f of fields) value[f] = rec[f];
  return { ok: true, value };
}

