// The story's facts for a release pin: the language's story analysis (the
// wasm check's own walk, as data), read through the interface legacy-lang's
// projection draws from. A scope is an id into the analysis's scopes.
//
// What the analysis does not carry, this recovers from the syntax tree the
// same release parsed: an extraction's words, and its field types (a
// primitive, or a refinement the program declares) with the author's `| null`. A field typed by a borrowed path
// (`<crm-[:companies]->.\`stage\`>`) has no structured type here; the language
// has no place to say it yet (DEFERRED: a structured `fieldType` on the
// analysis's extract fields).

import {
  authoredStringText,
  expressionOfSlot,
  resolveInAnalysis,
  type ExprSlot,
  type ExtractCallExpression,
  type ExtractExpression,
  type ExtractField,
  type ExtractNode,
  type ExtractStage,
  type LanguageVersion,
  type Program,
  type ShapeDeclaration,
  type ShapeNode,
  type Span,
  type StoryAnalysis,
  type StoryNode,
  type StorySymbol,
  type StoryExtractNode as AnalysedExtractNode,
} from 'movement-lang';
import {
  declaredTypesIn,
  maybeAbsent,
  parseFieldTypeName,
  sortedPathKey,
  spanContains,
  spanKey,
  walkStatements,
  type StoryEffects,
  type StoryExtractNode,
  type StoryFactNode,
  type StoryFactNodeKind,
  type StoryFactSymbol,
  type StoryFacts,
  type SchemaFieldType,
} from 'legacy-lang';

const UNKNOWN_EFFECTS: StoryEffects = { reads: [], writes: [], ai: false, now: false, suspend: false, partial: true };

export function analysisFacts(analysis: StoryAnalysis, program: Program, pin: LanguageVersion): StoryFacts<number> {
  const nodes = new Map<string, StoryFactNode<number>>();
  const valuePaths = new Map<string, { id: string; node: Extract<StoryNode, { kind: 'valuePath' }> }>();
  for (const node of analysis.nodes) {
    if (node.kind === 'valuePath') {
      // Keyed by the same structural token the projection asks with, never by
      // the analysis's own `key` string.
      const key = `${spanKey(node.span)}|${sortedPathKey(node.root ?? null, node.steps)}`;
      if (!valuePaths.has(key)) valuePaths.set(key, { id: `trv:${valuePaths.size}:${spanKey(node.span)}`, node });
      continue;
    }
    nodes.set(`${node.kind}:${spanKey(node.span)}`, factNodeOf(node));
  }
  const writes = new Map(analysis.writes.map((write) => [spanKey(write.span), write]));
  const bodies = new Map(analysis.bodies.map((body) => [`${body.kind}:${spanKey(body.span)}`, body.terminates]));
  const ordered = [...nodes.values()];
  const declaredTypes = declaredTypesIn(program);
  const shapeOf = (name: string) => shapeNamed(analysis, program, name);

  const node = <K extends StoryFactNodeKind>(kind: K, span: Span) => {
    const found = nodes.get(`${kind}:${spanKey(span)}`);
    return found !== undefined && isKind(found, kind) ? found : undefined;
  };

  return {
    fileScope: 0,
    scopeAt(span) {
      let best: { span: Span; id: number } | undefined;
      analysis.scopes.forEach((scope, id) => {
        if (scope.span === undefined || !spanContains(scope.span, span)) return;
        if (best === undefined || spanContains(best.span, scope.span)) best = { span: scope.span, id };
      });
      return best?.id ?? 0;
    },
    resolve(scope, name) {
      const symbol = resolveInAnalysis(analysis, scope, name);
      return symbol !== undefined ? factSymbolOf(symbol) : undefined;
    },
    visibleNames(scope) {
      const seen = new Set<string>();
      for (let at: number | undefined = scope; at !== undefined; at = analysis.scopes[at]?.parent) {
        for (const name of Object.keys(analysis.scopes[at]?.symbols ?? {})) seen.add(name);
      }
      return [...seen];
    },
    write: (span) => writes.get(spanKey(span)),
    node,
    instances: () => ordered.flatMap((n) => (isKind(n, 'instance') ? [n] : [])),
    listens: () => ordered.flatMap((n) => (isKind(n, 'listen') ? [n] : [])),
    valuePath(slot, root, steps) {
      const found = valuePaths.get(`${spanKey(slot)}|${sortedPathKey(root ?? null, steps)}`);
      if (found === undefined) return undefined;
      return {
        id: found.id,
        ...(found.node.root !== undefined ? { root: found.node.root } : {}),
        steps: found.node.steps,
        landings: found.node.landings.map((landing) => landing ?? undefined),
      };
    },
    // A body the analysis did not record caps nothing.
    terminates: (kind, span) => bodies.get(`${kind}:${spanKey(span)}`) ?? false,
    movementEffects: (scope, name) => resolveInAnalysis(analysis, scope, name)?.effects ?? UNKNOWN_EFFECTS,
    shape(statement) {
      return analysis.shapes.find((shape) => shape.name === statement.name && sameSpan(shape.span, statement.span))?.root;
    },
    extractTree(span, written) {
      const recorded = node('extract', span);
      const analysed = recorded !== undefined ? analysisExtractNodeAt(analysis, span) : undefined;
      if (analysed === undefined) return undefined;
      return describedTree(analysed, writtenRootOf(written, shapeOf), { shapeOf, declaredTypes });
    },
    expressionOf: (slot: ExprSlot) => expressionOfSlot(slot, pin),
  };
}

function analysisExtractNodeAt(analysis: StoryAnalysis, span: Span): AnalysedExtractNode | undefined {
  for (const node of analysis.nodes) {
    if (node.kind === 'extract' && sameSpan(node.span, span)) return node.node;
  }
  return undefined;
}

function factNodeOf(node: Exclude<StoryNode, { kind: 'valuePath' }>): StoryFactNode<number> {
  switch (node.kind) {
    case 'traversal':
      return { ...node, landings: node.landings.map((landing) => landing ?? undefined) };
    case 'instance':
    case 'listen':
    case 'link':
    case 'unlink':
    case 'await':
    case 'combinator':
    case 'branch':
    case 'extract':
    case 'call':
    case 'callReading':
    case 'delete':
    case 'refresh':
      return node;
  }
}

function isKind<K extends StoryFactNodeKind>(
  node: StoryFactNode<number>,
  kind: K,
): node is Extract<StoryFactNode<number>, { kind: K }> {
  return node.kind === kind;
}

function factSymbolOf(symbol: StorySymbol): StoryFactSymbol {
  return {
    span: symbol.span,
    kind: symbol.kind,
    ...(symbol.address !== undefined
      ? {
          address: {
            instance: symbol.address.instance,
            ...(symbol.address.position !== undefined ? { recordType: symbol.address.position } : {}),
          },
        }
      : {}),
    ...(symbol.extracted !== undefined ? { extracted: symbol.extracted } : {}),
    ...(symbol.effects !== undefined ? { effects: symbol.effects } : {}),
  };
}

// ── The author's words, from the syntax tree ──

/**
 * The syntax an extraction node was built from: an inline node and its
 * stages, or a node declaration (`extends` folded in) with the stages that
 * follow it and the words written where it is used.
 */
type WrittenNode =
  | { kind: 'inline'; description?: ExprSlot; stages: ExtractStage[] }
  | { kind: 'declared'; root: ShapeNode | undefined; description?: ExprSlot; stages: ExtractStage[] };

function writtenRootOf(
  written: ExtractExpression | ExtractCallExpression,
  shapeNamed: (name: string) => ShapeNode | undefined,
): WrittenNode | undefined {
  if ('stages' in written) return { kind: 'inline', stages: written.stages };
  switch (written.shape.kind) {
    case 'inline':
      return { kind: 'declared', root: written.shape.declaration.root, stages: [] };
    case 'named':
      return { kind: 'declared', root: shapeNamed(written.shape.name), stages: [] };
    case 'computed':
      return undefined;
  }
}

/** A node declaration by name: the file's, as the analysis resolved it, else one declared in a body. */
function shapeNamed(analysis: StoryAnalysis, program: Program, name: string): ShapeNode | undefined {
  const fileLevel = analysis.shapes.find((shape) => shape.name === name);
  if (fileLevel !== undefined) return fileLevel.root;
  let inBody: ShapeDeclaration | undefined;
  walkStatements(program.statements, (statement) => {
    if (statement.kind === 'shape' && statement.name === name && inBody === undefined) inBody = statement;
  });
  return inBody?.root;
}

/** The analysis's tree, with each node's and field's words, and each field's
 *  primitive type, read off the syntax it was built from. */
interface Recovery {
  shapeOf: (name: string) => ShapeNode | undefined;
  /** The refinements the program declares (`type Thesis = <"A" | "B">`), by name. */
  declaredTypes: Map<string, SchemaFieldType>;
}

function describedTree(analysed: AnalysedExtractNode, written: WrittenNode | undefined, recovery: Recovery): StoryExtractNode {
  const description = written !== undefined ? writtenDescription(written) : undefined;
  const fields = written !== undefined ? writtenFields(written) : [];
  const children = written !== undefined ? writtenChildren(written, recovery.shapeOf) : new Map<string, WrittenNode>();
  return {
    name: analysed.name,
    ...(description !== undefined ? { description: authoredStringText(description.raw) } : {}),
    fields: analysed.fields.map((field) => {
      // By the field's own span: the line that declared it last.
      const line = fields.find((f) => f.name === field.name && sameSpan(f.span, field.at));
      const type = line !== undefined ? fieldType(line, recovery.declaredTypes) : undefined;
      return {
        name: field.name,
        ...(line?.description !== undefined ? { description: authoredStringText(line.description.raw) } : {}),
        ...(type !== undefined ? { type } : {}),
        at: field.at,
      };
    }),
    children: analysed.children.map((child) => describedTree(child, children.get(child.name), recovery)),
  };
}

function writtenDescription(written: WrittenNode): ExprSlot | undefined {
  switch (written.kind) {
    case 'inline':
      return written.description;
    // The use site's words replace the declaration's.
    case 'declared':
      return written.description ?? written.root?.description;
  }
}

type WrittenField = Pick<ExtractField, 'name' | 'type' | 'nullable' | 'span'> & { description?: ExprSlot };

function writtenFields(written: WrittenNode): WrittenField[] {
  const declared: WrittenField[] = written.kind === 'declared' ? (written.root?.fields ?? []) : [];
  return [...declared, ...written.stages.flatMap((stage) => stage.fields)];
}

/** The children by name; a later stage's node replaces an earlier one, as the check builds it. */
function writtenChildren(written: WrittenNode, shapeNamed: (name: string) => ShapeNode | undefined): Map<string, WrittenNode> {
  const children = new Map<string, WrittenNode>();
  if (written.kind === 'declared') {
    for (const child of written.root?.children ?? []) {
      children.set(child.name, { kind: 'declared', root: child, stages: [] });
    }
  }
  for (const stage of written.stages) {
    for (const child of stage.children) children.set(child.name, writtenChild(child, shapeNamed));
  }
  return children;
}

function writtenChild(child: ExtractNode, shapeNamed: (name: string) => ShapeNode | undefined): WrittenNode {
  if (child.declared === undefined) return { kind: 'inline', description: child.description, stages: child.stages };
  return {
    kind: 'declared',
    root: shapeNamed(child.declared.type),
    ...(child.description !== undefined ? { description: child.description } : {}),
    stages: child.stages,
  };
}

/** A primitive or declared annotation, made maybe-absent by the author's `| null`. */
function fieldType(field: WrittenField, declaredTypes: Map<string, SchemaFieldType>): SchemaFieldType | undefined {
  const named = parseFieldTypeName(field.type) ?? (field.type !== undefined ? declaredTypes.get(field.type) : undefined);
  if (named === undefined) return undefined;
  return field.nullable ? (maybeAbsent(named) ?? named) : named;
}

function sameSpan(a: Span, b: Span): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col;
}
