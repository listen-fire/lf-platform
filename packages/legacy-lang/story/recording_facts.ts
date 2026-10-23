// The story's facts for a legacy pin: this package's own check recording, read
// as the projection has always read it. A scope is the checker's live `Scope`.

import type { TraversalStep } from 'movement-lang/expression/types';
import type { ExprSlot, ShapeDeclaration, ShapeNode, Span, Statement } from 'movement-lang/parser/ast';
import { expressionOfSlot } from '../expression/bridge';
import { EMPTY_ROW, instanceNames, type EffectRow } from '../checker/effects';
import { bodyExits, terminates } from '../checker/flow';
import type { LanguageVersion } from '../language_version';
import {
  EXTRACT_ROOT_NAME,
  maybeAbsent,
  type ExtractNodeType,
  type PositionTypeRef,
} from '../checker/typing';
import type { Scope, ScopeSymbol } from '../checker/scopes';
import type { CheckRecording, RecordedNode, RecordedValuePath, RecordedWrite } from '../checker/check';
import {
  sortedPathKey,
  spanContains,
  spanKey,
  type StoryBodyKind,
  type StoryFactNode,
  type StoryFactNodeKind,
  type StoryFactSymbol,
  type StoryFactValuePath,
  type StoryFacts,
} from './facts';
import type { StoryEffects, StoryExtractNode } from './story';

export function recordingFacts(recording: CheckRecording, languageVersion: LanguageVersion): StoryFacts<Scope> {
  const writes = new Map<string, RecordedWrite>();
  const nodes = new Map<string, RecordedNode>();
  /** Walks inside an expression, by the slot they were written in and the
   *  chain they walk — a slot can hold more than one. */
  const valuePaths = new Map<string, RecordedValuePath>();
  /** A stable id per recorded value path, in recording order — the key a
   *  resolved view hangs a walk's display vocabulary on, exactly as a head's
   *  own span-derived id does. A slot can hold two walks, so the span alone
   *  would not tell them apart. */
  const valuePathIds = new Map<string, string>();
  for (const write of recording.writes) writes.set(spanKey(write.span), write);
  for (const node of recording.nodes) {
    nodes.set(`${node.kind}:${spanKey(node.span)}`, node);
    if (node.kind === 'valuePath') {
      const key = `${spanKey(node.span)}|${sortedPathKey(node.root ?? null, node.steps)}`;
      if (!valuePaths.has(key)) {
        valuePaths.set(key, node);
        valuePathIds.set(key, `trv:${valuePathIds.size}:${spanKey(node.span)}`);
      }
    }
  }
  const fileScope = recording.frames[0]?.scope;

  /**
   * The innermost recorded frame containing `span`. Used where no recorded node
   * carries the scope directly (a statement the checker resolves without
   * recording anything of its own); the frames were recorded by the same walk,
   * so this is the scope the checker stood in.
   */
  const scopeAt = (span: Span): Scope => {
    let best: { span: Span; scope: Scope } | undefined;
    for (const frame of recording.frames) {
      if (!spanContains(frame.span, span)) continue;
      if (best === undefined || spanContains(best.span, frame.span)) {
        best = { span: frame.span, scope: frame.scope };
      }
    }
    if (best !== undefined) return best.scope;
    // The file frame is recorded first and covers everything; falling back to
    // it keeps the projection total on a recording that has one.
    if (fileScope !== undefined) return fileScope;
    throw new Error('projectStory: the recording has no scope frames');
  };

  const node = <K extends StoryFactNodeKind>(kind: K, span: Span) => {
    const recorded = nodes.get(`${kind}:${spanKey(span)}`);
    return recorded !== undefined && isKind(recorded, kind) ? recorded : undefined;
  };

  return {
    get fileScope(): Scope {
      if (fileScope === undefined) throw new Error('projectStory: the recording has no scope frames');
      return fileScope;
    },
    scopeAt,
    resolve(scope, name) {
      const resolution = scope.resolve(name);
      return resolution.kind === 'found' ? factSymbolOf(resolution.symbol) : undefined;
    },
    visibleNames(scope) {
      const seen = new Set<string>();
      for (let s: Scope | undefined = scope; s; s = s.parent) {
        for (const name of s.symbols.keys()) seen.add(name);
      }
      return [...seen];
    },
    write: (span) => writes.get(spanKey(span)),
    node,
    instances: () => recording.nodes.flatMap((n) => (isKind(n, 'instance') ? [n] : [])),
    listens: () => recording.nodes.flatMap((n) => (isKind(n, 'listen') ? [n] : [])),
    valuePath(slot: Span, root: string | undefined, steps: TraversalStep[]): StoryFactValuePath | undefined {
      const key = `${spanKey(slot)}|${sortedPathKey(root ?? null, steps)}`;
      const recorded = valuePaths.get(key);
      const id = valuePathIds.get(key);
      if (recorded === undefined || id === undefined) return undefined;
      return { id, ...(recorded.root !== undefined ? { root: recorded.root } : {}), steps: recorded.steps, landings: recorded.landings };
    },
    terminates(kind: StoryBodyKind, _span: Span, statements: Statement[]): boolean {
      switch (kind) {
        // A `return` written straight in the body is a step on the spine,
        // not a capped lane, so it leaves the run's own ending to be drawn;
        // only a terminator that caps its lanes stands in for that ending.
        case 'movement':
          return terminates(statements.filter((s) => s.kind !== 'return'), bodyExits(languageVersion));
        // The checker's own rule for this version, so a lane is capped exactly
        // where the checker narrows below the `if`.
        case 'arm':
        case 'else':
          return terminates(statements, bodyExits(languageVersion));
        // A `return` here is the arm's VALUE: the combinator takes it and the
        // run carries on, so only an `ERROR` caps a lane.
        case 'combinatorArm':
          return terminates(statements, { returns: false });
      }
    },
    movementEffects: (scope, name) => storyEffects(declaredMovementRow(scope, name)),
    shape(statement: ShapeDeclaration): ShapeNode | undefined {
      const symbol = fileScope?.symbols.get(statement.name);
      return symbol?.kind === 'shape' && sameSpan(symbol.span, statement.span) ? symbol.declaration?.root : undefined;
    },
    extractTree(span) {
      const recorded = nodes.get(`extract:${spanKey(span)}`);
      return recorded?.kind === 'extract' ? projectExtractNode(recorded.node) : undefined;
    },
    expressionOf: (slot: ExprSlot) => expressionOfSlot(slot, languageVersion),
  };
}

function isKind<K extends StoryFactNodeKind>(
  node: RecordedNode,
  kind: K,
): node is RecordedNode & Extract<StoryFactNode<Scope>, { kind: K }> {
  return node.kind === kind;
}

function factSymbolOf(symbol: ScopeSymbol): StoryFactSymbol {
  const posType = symbol.posType;
  const extracted = posType !== undefined ? extractNodeOf(posType) : undefined;
  const address = posType !== undefined ? positionAddress(posType) : undefined;
  const effects = symbol.movement?.effects;
  return {
    span: symbol.span,
    kind: symbol.kind,
    ...(address?.instance !== undefined
      ? { address: { instance: address.instance, ...(address.recordType !== undefined ? { recordType: address.recordType } : {}) } }
      : {}),
    ...(extracted !== undefined
      ? { extracted: extracted.name !== EXTRACT_ROOT_NAME ? { entity: extracted.name } : {} }
      : {}),
    ...(effects !== undefined ? { effects: storyEffects(effects) } : {}),
  };
}

/** The extraction node a type stands on, through the absence wrapper. */
function extractNodeOf(type: PositionTypeRef): ExtractNodeType | undefined {
  if (type.kind === 'extract') return type.node;
  if (type.kind === 'maybeEmpty') return extractNodeOf(type.of);
  return undefined;
}

/**
 * WHERE a type sits, as the pair a display label is looked up by. Only the
 * kinds that HAVE a place answer: a checker-local node belongs to no system, a
 * block meta and a race receipt are structures rather than positions, and
 * saying nothing for them is what keeps their references honest.
 */
function positionAddress(
  type: PositionTypeRef,
): { instance?: string; recordType?: string } | undefined {
  switch (type.kind) {
    case 'position':
      return { instance: type.instance.name, recordType: type.position };
    case 'union':
      return { instance: type.instance.name, recordType: type.union };
    case 'handle':
      return {
        instance: type.instance.name,
        ...(type.position !== undefined ? { recordType: type.position } : {}),
      };
    case 'meta':
      return { instance: type.instance.name };
    case 'maybeEmpty':
      return positionAddress(type.of);
    // One of several records has no one place.
    case 'oneOf':
      return undefined;
    case 'extract':
    case 'closure':
    case 'local':
      return undefined;
  }
}

/**
 * A declared movement's inferred row, off the symbol the checker filed it on.
 * An unchecked program (or one whose declaration never resolved) has no row —
 * which is a lower bound, not "does nothing", so the fallback says so.
 */
function declaredMovementRow(scope: Scope, name: string): EffectRow {
  const resolution = scope.resolve(name);
  if (resolution.kind !== 'found') return { ...EMPTY_ROW, partial: true };
  return resolution.symbol.movement?.effects ?? { ...EMPTY_ROW, partial: true };
}

function storyEffects(row: EffectRow): StoryEffects {
  return {
    reads: instanceNames(row.read),
    writes: instanceNames(row.write),
    ai: row.ai,
    now: row.now,
    suspend: row.suspend,
    partial: row.partial,
  };
}

function projectExtractNode(node: ExtractNodeType): StoryExtractNode {
  return {
    name: node.name,
    ...(node.description !== undefined ? { description: node.description } : {}),
    fields: [...node.properties.entries()].map(([name, info]) => ({
      name,
      ...(info.description !== undefined ? { description: info.description } : {}),
      ...(info.explicit !== undefined
        ? { type: info.nullable ? (maybeAbsent(info.explicit) ?? info.explicit) : info.explicit }
        : {}),
      at: info.span,
    })),
    children: [...node.children.values()].map(projectExtractNode),
  };
}

// By value: a span read back from the checker's scope need not be the very
// object the parse produced.
function sameSpan(a: Span, b: Span): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col;
}
