// The EFFECT ROW — one inferred fact per function: what running it may do.
//
// A row answers "reads crm, writes slack, calls a model, waits" for a movement
// or a closure. For a body the checker can walk it is INFERRED, and there is no
// surface syntax for one. For a body it cannot — a plugin, an adapter's field
// function — it is DECLARED beside that function's arguments, and folded into a
// caller by the same `absorb`; that is what makes a plugin an ordinary function
// rather than a name legal in one syntactic slot. Consumers are the picture
// (where a run can pause), the plugin call gate, and — later — the
// cancellable-arm warning and dry-run.
//
// Two things the shape is deliberate about:
//
//   - `read` and `write` carry the SOURCE they touch, not a boolean. The
//     picture needs "writes to crm"; authority is already scoped per instance;
//     and a boolean would mean "touches something", which is the one-value-two-
//     facts smell. A source is an identity (`token`, compared by reference, so
//     it cannot collide) plus a display name. A constructed instance is one; so
//     is the synthetic source a DECLARED row names (`vc_url_retrieval` reads
//     the web, which is not one of the author's graphs).
//   - `partial` says the row is a LOWER BOUND: some site or callee did not
//     type, so what is listed is real but may not be all of it. Without it an
//     unresolved call would read as "does nothing", which is a claim the
//     checker has no business making.
//
// Inference is bottom-up over the call graph: a function's row is the union of
// its body's primitive effects and the rows of what it calls. Before language
// version 3 there is no recursion, so there is no fixpoint to find. From
// version 3 functions may call each other in a cycle, and every function in
// one shares a single row — the union of all their bodies' (`call_cycles.ts`).

// The part of this file the language package keeps; re-exported first so a cycle through this module sees it.
export { type DeclaredEffectRow } from 'movement-lang/catalog/types';
import type { ScopeSymbol } from './scopes';
import type { InstanceRef } from './typing';
import { type DeclaredEffectRow } from 'movement-lang/catalog/types';


/**
 * What a row's `read`/`write` entries have to be: an IDENTITY to dedupe by and
 * a NAME to print. Exactly the two things every consumer uses, and no more.
 *
 * A constructed instance is one — an `InstanceRef` widened, so nothing at a
 * call site changes. The other kind is the SYNTHETIC source a function whose
 * body nobody can see declares it touches: `vc_url_retrieval` reads the web,
 * and the web is not one of the author's graphs. Giving such a source an empty
 * `InstanceSchema` to fit the old shape would be claiming it has no positions —
 * a fabricated fact where the honest one is "this isn't a graph at all".
 */
export interface EffectSource {
  readonly token: object;
  readonly name: string;
}

/**
 * The identity of a synthetic source, INTERNED by name: two declarations that
 * name the web mean the same web, so a row that absorbs both lists it once.
 * The token is only ever compared — the same contract every `InstanceRef.token`
 * has, and the reason the name is free to be display text.
 */
const syntheticSources = new Map<string, EffectSource>();

export function syntheticSource(name: string): EffectSource {
  const existing = syntheticSources.get(name);
  if (existing !== undefined) return existing;
  const minted: EffectSource = { token: { synthetic: name }, name };
  syntheticSources.set(name, minted);
  return minted;
}

/** A declared row as the row every consumer already reads. Complete by
 *  construction: a declaration that lists nothing declares NO effects, which is
 *  a different answer from not declaring one. */
export function rowFromDeclaration(declared: DeclaredEffectRow): EffectRow {
  return {
    read: (declared.reads ?? []).map(syntheticSource),
    write: (declared.writes ?? []).map(syntheticSource),
    ai: declared.ai === true,
    now: declared.now === true,
    suspend: declared.suspend === true,
    partial: false,
  };
}

/**
 * What a function may do. `read`/`write` are deduped by `EffectSource.token`
 * and kept in first-seen order, so a row is stable across two checks of the
 * same source. `ai`, `now` and `suspend` are flags — a park POINT is an
 * address in the body, not row data.
 */
export interface EffectRow {
  /** Sources a run may read from (a traversal, a `refresh`, a declared read). */
  readonly read: readonly EffectSource[];
  /** Sources a run may write to (`write`, `link`, `unlink`, `delete`). */
  readonly write: readonly EffectSource[];
  /** Calls a model: `extract`, `AI(…)`, `LLM_AGG(…)`, `EXTRACT_VALUE(…)`. */
  readonly ai: boolean;
  /** Reads the wall clock: `@current_date` / `@current_timestamp`. */
  readonly now: boolean;
  /** May park the run: any `await`, in any of its forms. */
  readonly suspend: boolean;
  /**
   * The row is a LOWER BOUND — a site or a callee did not type, so there may
   * be effects it cannot list. "Does nothing" and "we could not see" are
   * different answers and this is what tells them apart.
   */
  readonly partial: boolean;
}

/** The row of a function that does nothing — and is KNOWN to do nothing. */
export const EMPTY_ROW: EffectRow = {
  read: [],
  write: [],
  ai: false,
  now: false,
  suspend: false,
  partial: false,
};

/** The row of a function nobody could look inside: no effect is claimed, and
 *  the row says so. */
export const UNKNOWN_ROW: EffectRow = { ...EMPTY_ROW, partial: true };

/** Everything any of `rows` may do — the row of running any one of them. */
export function unionRows(rows: Iterable<EffectRow>): EffectRow {
  const frame = new EffectFrame();
  for (const row of rows) frame.absorb(row);
  return frame.close();
}

/** Purity, derived: an empty row that is not a lower bound. */
export function isPureRow(row: EffectRow): boolean {
  return (
    !row.partial &&
    !row.ai &&
    !row.now &&
    !row.suspend &&
    row.read.length === 0 &&
    row.write.length === 0
  );
}

/** Whether `row` names `instance` among the given kind's entries — identity by
 *  graph token, the same comparison the type checker makes. */
export function rowTouches(
  row: EffectRow,
  kind: 'read' | 'write',
  instance: EffectSource,
): boolean {
  return row[kind].some(entry => entry.token === instance.token);
}

/**
 * The row filed on a declaration — the per-declaration fact the picture and the
 * language service both read, off the `ScopeSymbol` they already hold.
 * Undefined for a symbol that is not a movement, and for one whose body the
 * check never reached.
 */
export function effectRowOf(symbol: ScopeSymbol): EffectRow | undefined {
  return symbol.movement?.effects;
}

/** The binding names a row's entries were written under, in first-seen order —
 *  display only. Identity stays the token. */
export function instanceNames(entries: readonly EffectSource[]): string[] {
  return entries.map(entry => entry.name);
}

/**
 * One function's row while its body is being walked. The checker keeps a stack
 * of these — one per FUNCTION BODY, not per scope: an `if` arm, a race branch
 * and a traversal block all belong to the function around them, while a closure
 * is its own function and its row rides in its type.
 */
export class EffectFrame {
  private readonly reads = new Map<object, EffectSource>();
  private readonly writes = new Map<object, EffectSource>();
  private ai = false;
  private now = false;
  private suspend = false;
  private partial = false;

  /**
   * One read (or write) site, offering every graph it might belong to — a
   * traversal offers its start and each landing. Every graph that RESOLVED is
   * recorded; the row is marked incomplete only when none did, which is the
   * difference between "an untyped hop in the middle of a walk we can still
   * name" and "a site nobody could place".
   */
  addRead(...candidates: Array<InstanceRef | undefined>): void {
    this.add(this.reads, candidates);
  }

  addWrite(...candidates: Array<InstanceRef | undefined>): void {
    this.add(this.writes, candidates);
  }

  private add(
    into: Map<object, EffectSource>,
    candidates: Array<InstanceRef | undefined>,
  ): void {
    let resolved = false;
    for (const instance of candidates) {
      if (instance === undefined) continue;
      resolved = true;
      if (!into.has(instance.token)) into.set(instance.token, instance);
    }
    if (!resolved) this.partial = true;
  }

  flag(effect: 'ai' | 'now' | 'suspend'): void {
    this[effect] = true;
  }

  /** Something happened whose effects nobody can see — an unresolved callee, an
   *  untyped site. */
  markPartial(): void {
    this.partial = true;
  }

  /** Fold a callee's (or an invoked closure's) row in. Calling adds the
   *  callee's effects; capturing a closure adds nothing, so only invocation
   *  sites reach here. */
  absorb(row: EffectRow): void {
    for (const instance of row.read) {
      if (!this.reads.has(instance.token)) this.reads.set(instance.token, instance);
    }
    for (const instance of row.write) {
      if (!this.writes.has(instance.token)) this.writes.set(instance.token, instance);
    }
    if (row.ai) this.ai = true;
    if (row.now) this.now = true;
    if (row.suspend) this.suspend = true;
    if (row.partial) this.partial = true;
  }

  close(): EffectRow {
    return {
      read: [...this.reads.values()],
      write: [...this.writes.values()],
      ai: this.ai,
      now: this.now,
      suspend: this.suspend,
      partial: this.partial,
    };
  }
}
