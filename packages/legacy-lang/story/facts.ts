// What the story projection needs to know about a checked program, beyond its
// syntax tree: the scopes the check stood in, what each name resolved to, and
// what the check recorded at each construct.
//
// Two sources answer it. This package's own check recording serves a legacy
// pin (`recording_facts.ts`); the platform reads the language's story analysis
// for a release pin. The projection reads only this interface, so one
// projection draws both, and the two pictures cannot drift by having two
// projections.
//
// `S` is a scope as the source holds it: a live `Scope` for the recording, an
// id for the analysis. The projection never looks inside one.

import type { Expression, TraversalStep } from 'movement-lang/expression/types';
import type {
  CollectionOpExpression,
  CombinatorKind,
  ExprSlot,
  ExtractCallExpression,
  ExtractExpression,
  FieldEntry,
  MembersExpression,
  ShapeDeclaration,
  ShapeNode,
  Span,
  Statement,
} from 'movement-lang/parser/ast';
import type { StoryEffects, StoryExtractNode } from './story';

/** What a name resolved to, as far as a story says it. */
export interface StoryFactSymbol {
  span: Span;
  /** The symbol's kind; `param` is what came in. */
  kind: string;
  /** Where the record the name holds is: a system's binding and its record type. */
  address?: { instance: string; recordType?: string };
  /** The name holds an extraction's graph; `entity` is absent at its root. */
  extracted?: { entity?: string };
  /** Movements only: what the movement may do. */
  effects?: StoryEffects;
}

export interface StoryFactWrite<S> {
  scope: S;
  /** The field lines, spreads written out. */
  fields: FieldEntry[];
  binding?: string;
  target?: { instance: string; recordType?: string };
  action: 'create' | 'update' | 'find';
  /** The parent edges the write's form establishes, in path order. */
  parents: Array<{ edge: string }>;
}

export interface StoryFactLanding {
  instance: string;
  position?: string;
}

/** A walk's root, its hops, and where each hop landed (absent where it did not type). */
export interface StoryFactWalk {
  root?: string;
  steps: TraversalStep[];
  landings: Array<StoryFactLanding | undefined>;
}

/** A walk written as a value, with the stable id a resolved view hangs its vocabulary on. */
export interface StoryFactValuePath extends StoryFactWalk {
  id: string;
}

export type StoryFactAwaitSource =
  | { kind: 'traversal'; root?: string; edge?: string; awaitable?: boolean }
  | { kind: 'sleep'; duration: string }
  | { kind: 'until'; every?: string };

export type StoryFactCallReading =
  | { kind: 'value'; expr: ExprSlot }
  | { kind: 'collection'; collection: CollectionOpExpression }
  | { kind: 'members'; members: MembersExpression }
  | { kind: 'refused' };

/** What the check recorded at one construct, and the scope it stood in. */
export type StoryFactNode<S> = { span: Span; scope: S } & (
  | { kind: 'instance'; name: string; adapterType?: string }
  | {
      kind: 'listen';
      instance: string;
      adapterType?: string;
      fires: string;
      firesMovement: boolean;
      events?: string[];
      narrowing: Record<string, string>;
      eventTypes: Array<{ key: string; display?: string }>;
    }
  | { kind: 'link'; from: string; edge: string }
  | { kind: 'unlink' }
  | { kind: 'await'; source: StoryFactAwaitSource }
  | { kind: 'combinator'; combinator: CombinatorKind; arms: Array<{ span: Span }> }
  | { kind: 'branch'; arms: Array<{ scope: S }> }
  | { kind: 'extract' }
  /** `argParams[i]` names the parameter argument `i` binds; empty past the last one. */
  | { kind: 'call'; isMovement: boolean; argParams?: ReadonlyArray<string | null | undefined> }
  | { kind: 'callReading'; reading: StoryFactCallReading }
  | (StoryFactWalk & { kind: 'traversal'; from?: 'graph' | 'result' })
  | { kind: 'delete' }
  | { kind: 'refresh' }
);

export type StoryFactNodeKind = StoryFactNode<unknown>['kind'];

/** A statement list a lane is capped by, by the rule of its kind. */
export type StoryBodyKind = 'movement' | 'arm' | 'else' | 'combinatorArm';

export interface StoryFacts<S> {
  /** The file's own scope. */
  readonly fileScope: S;
  /** The innermost scope whose text contains `span`; the file's when none does. */
  scopeAt(span: Span): S;
  resolve(scope: S, name: string): StoryFactSymbol | undefined;
  /** Every name visible from `scope`, an inner binding hiding an outer one of the same name. */
  visibleNames(scope: S): string[];
  /** The write or match whose body is at `span`. */
  write(span: Span): StoryFactWrite<S> | undefined;
  node<K extends StoryFactNodeKind>(kind: K, span: Span): Extract<StoryFactNode<S>, { kind: K }> | undefined;
  /** The constructed instances, in source order. */
  instances(): Array<Extract<StoryFactNode<S>, { kind: 'instance' }>>;
  /** The listens, in source order. */
  listens(): Array<Extract<StoryFactNode<S>, { kind: 'listen' }>>;
  /** The walk written as a value in the slot at `slot`, rooted at `root` and taking `steps`. */
  valuePath(slot: Span, root: string | undefined, steps: TraversalStep[]): StoryFactValuePath | undefined;
  /** Whether the body at `span` leaves, by its kind's rule. */
  terminates(kind: StoryBodyKind, span: Span, statements: Statement[]): boolean;
  /** What the movement `name` may do, as resolved from `scope`; a lower bound where unknown. */
  movementEffects(scope: S, name: string): StoryEffects;
  /** The node declaration the check resolved for `statement` (`extends` folded in). */
  shape(statement: ShapeDeclaration): ShapeNode | undefined;
  /** The graph the extraction at `span` produces; `written` is its syntax, for
   *  a source that recovers the author's words from it. */
  extractTree(span: Span, written: ExtractExpression | ExtractCallExpression): StoryExtractNode | undefined;
  /** The expression a slot holds, as the program's own version reads it. Throws where it does not parse. */
  expressionOf(slot: ExprSlot): Expression;
}

/**
 * The comparable token for one walk: its root and steps as JSON with every
 * object's keys sorted. Both fact sources key their walks by it, so a walk is
 * matched by its structure and never by how one producer happened to order
 * a step's members.
 */
export function sortedPathKey(root: string | null, steps: readonly TraversalStep[]): string {
  return JSON.stringify([root, steps], (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** A span as a map key. */
export function spanKey(span: Span): string {
  return `${span.start.line}:${span.start.col}-${span.end.line}:${span.end.col}`;
}

/** Whether `outer` contains `inner`, ends included. */
export function spanContains(outer: Span, inner: Span): boolean {
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

function before(a: { line: number; col: number }, b: { line: number; col: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}
