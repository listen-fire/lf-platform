// The universal `dry_run` construction parameter, read off a 0.15 program: the
// dry_run⇄live axis a listen's trigger row keeps. Production's save derived it
// at 0.15.3 (`movement/dry_run.ts`); this is that derivation on 0.15's own
// parse. The platform's copy reads its program through legacy-lang's name and
// alias readers, which read the 0.12 surface, so none of it reads a 0.15 text.
//
// Dry-run is movement-level: the engine takes one dryRun switch per run, so the
// whole movement is 'dry_run' exactly when EVERY written-to instance was
// constructed `dry_run: true`. Mixed dry and live instances surface as 'mixed'
// with the offending write's span.

import {
  expressionOfSlot,
  pathRootName,
  scanName,
  type ConstructionCall,
  type MovementDeclaration,
  type PathHead,
  type Program,
  type Span,
  type Statement,
  type WriteExpression,
} from '@listen-fire/movement-lang';
import type { Expression, TraversalStep } from '@listen-fire/movement-lang/expression/types';
import { listElementExpression, objectMemberExpression } from '@listen-fire/movement-lang/expression/types';

export type MovementWriteRunMode = { mode: 'live' | 'dry_run' } | { mode: 'mixed'; span: Span };

// A name's position decides whether a rootless spelling is a variable or a
// field: in `value` position a bare name is a reference to resolve against
// scope; in `field` position (a traversal's tail, a step filter, an extract
// slot) it is a field of the traversal head; in `member` position it is a
// member of what a dotted read's root holds.
type NamePosition = 'value' | 'field' | 'member';

function namesInSteps(steps: readonly TraversalStep[], refs: string[]): void {
  for (const step of steps) {
    switch (step.type) {
      case 'edge':
        if (step.expressionFilter !== undefined) namesIn(step.expressionFilter, refs, 'field');
        break;
      case 'meta_edge': {
        if (step.expressionFilter !== undefined) namesIn(step.expressionFilter, refs, 'field');
        const config = step.config;
        if (config === undefined) break;
        if (config.description !== undefined) namesIn(config.description, refs, 'field');
        for (const data of config.data ?? []) namesIn(data, refs, 'field');
        if (config.plugin !== undefined) namesIn(config.plugin, refs, 'field');
        for (const entry of config.enrichWith ?? []) {
          namesIn(entry.transform, refs, 'field');
          namesIn(entry.argument, refs, 'field');
        }
        for (const extra of Object.values(config.extra ?? {})) namesIn(extra, refs, 'field');
        break;
      }
      case 'linkBack':
      case 'resource':
        break;
      default: {
        const unknown: never = step;
        throw new Error(`unknown traversal step ${JSON.stringify(unknown)}`);
      }
    }
  }
}

/** The names `expr` reads from the scope it is evaluated in. */
function namesIn(expr: Expression, refs: string[], position: NamePosition = 'value'): void {
  switch (expr.type) {
    case 'alias_ref':
      refs.push(expr.name);
      return;
    case 'traverse':
      // A dotted read's tail (`m.k.f`'s `k.f`) is rooted at a member of what
      // the head holds, not at a name in scope.
      if (expr.aliasRoot !== undefined && position !== 'member') refs.push(expr.aliasRoot);
      namesInSteps(expr.steps, refs);
      namesIn(expr.expression, refs, expr.steps.length === 0 ? 'member' : 'field');
      return;
    case 'exists':
      namesInSteps(expr.steps, refs);
      if (expr.where !== undefined) namesIn(expr.where, refs, 'field');
      return;
    case 'resource_traverse':
      if (expr.expressionFilter !== undefined) namesIn(expr.expressionFilter, refs, 'field');
      namesIn(expr.expression, refs, 'field');
      return;
    case 'llm':
      if (expr.promptExpression !== undefined) namesIn(expr.promptExpression, refs, 'value');
      return;
    case 'list':
      for (const element of expr.elements) namesIn(listElementExpression(element), refs, position);
      return;
    // An object literal's keys are the target's own spelling, never names.
    case 'object':
      for (const member of expr.entries) namesIn(objectMemberExpression(member), refs, position);
      return;
    case 'arithmetic':
    case 'compare':
      namesIn(expr.left, refs, position);
      namesIn(expr.right, refs, position);
      return;
    case 'logical':
      for (const operand of expr.operands) namesIn(operand, refs, position);
      return;
    case 'not':
    case 'negate':
      namesIn(expr.expression, refs, position);
      return;
    case 'concat':
      for (const part of expr.parts) namesIn(part, refs, position);
      return;
    case 'conditional':
      namesIn(expr.condition, refs, position);
      namesIn(expr.then, refs, position);
      namesIn(expr.else, refs, position);
      return;
    case 'at':
      namesIn(expr.expression, refs, position);
      namesIn(expr.index, refs, position);
      return;
    case 'aggregate':
      namesIn(expr.expression, refs, position);
      return;
    case 'function':
      for (const arg of expr.args) namesIn(arg, refs, position);
      return;
    case 'kg_exists':
    case 'kg_value':
      for (const param of expr.params) namesIn(param, refs, position);
      return;
    case 'property':
      // A hop's alias read is a field, never a name to resolve.
      if (position === 'value' && expr.fieldOnly !== true) refs.push(expr.propertyTypeId);
      return;
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'action_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
      return;
    default: {
      const unknown: never = expr;
      throw new Error(`unknown expression ${JSON.stringify(unknown)}`);
    }
  }
}

function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

/** The alias opening a hop's interior (`c:`, `` `a b`: ``), read as every
 *  other name is. */
function hopAliasAt(hopsRaw: string, interiorStart: number): string | undefined {
  let i = interiorStart;
  while (i < hopsRaw.length && /\s/.test(hopsRaw[i] ?? '')) i++;
  const scanned = scanName(hopsRaw, i);
  if (scanned === null) return undefined;
  let j = scanned.end;
  while (j < hopsRaw.length && /\s/.test(hopsRaw[j] ?? '')) j++;
  return hopsRaw[j] === ':' ? scanned.name : undefined;
}

/** The aliases a head's hops bind, read from the raw hop text: a `_resources`
 *  head parses to a resource walk, which keeps neither alias nor root. */
function hopAliasesOf(hopsRaw: string): string[] {
  const aliases: string[] = [];
  let i = 0;
  while (i < hopsRaw.length) {
    const open = hopsRaw.indexOf('-[', i);
    if (open === -1) break;
    const interiorStart = open + 2;
    const alias = hopAliasAt(hopsRaw, interiorStart);
    if (alias !== undefined) aliases.push(alias);
    let depth = 1;
    let j = interiorStart;
    while (j < hopsRaw.length && depth > 0) {
      const ch = hopsRaw[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        j = skipQuoted(hopsRaw, j);
        continue;
      }
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') depth--;
      j++;
    }
    i = j;
  }
  return aliases;
}

/**
 * A traversal-head alias inherits its owning instance from the head's root. A
 * head rooted at an expression (`AT(rows, 0)-[c:company]->`) has no name to
 * inherit from, so the owner is read off the names the expression reads: one
 * agreed owner is the answer; two that disagree, or none that is known, leaves
 * the aliases owner-unknown, as a rootless head does.
 */
function headOwner(input: { head: PathHead; handleOwner: ReadonlyMap<string, string>; resolveOwner: (name: string) => string; pin: string }): string | undefined {
  const root = input.head.root;
  if (root === undefined) return undefined;
  if (root.kind === 'name') return input.resolveOwner(root.name);
  const refs: string[] = [];
  try {
    namesIn(expressionOfSlot(root.expr, input.pin), refs);
  } catch {
    return undefined; // unparseable: the checker owns that diagnostic
  }
  const owners = new Set(refs.filter((name) => input.handleOwner.has(name)).map((name) => input.resolveOwner(name)));
  return owners.size === 1 ? [...owners][0] : undefined;
}

/**
 * Which run mode a movement's writes imply, from 0.15's parse alone. A write's
 * owning instance is its target instance, or, for a linked write, the instance
 * that produced the parent handle. A write whose owner is not a `dry_run: true`
 * construction (`kg` among them, which is never constructed) counts as live.
 */
export function movementWriteRunMode(input: { program: Program; movement: string | undefined; pin: string }): MovementWriteRunMode {
  const { program, pin } = input;
  const dryInstances = new Set<string>();
  const recordConstruction = (name: string, construct: ConstructionCall): void => {
    const dryArg = construct.args.find((a) => a.name === 'dry_run');
    if (dryArg !== undefined && dryArg.value.raw.trim().toLowerCase() === 'true') dryInstances.add(name);
  };
  for (const statement of program.statements) {
    if (statement.kind === 'assign' && statement.value.kind === 'construct') recordConstruction(statement.name, statement.value.construct);
  }

  const movements = program.statements.filter((s): s is MovementDeclaration => s.kind === 'movement');
  const byName = new Map(movements.map((m) => [m.name, m]));
  const movement = input.movement !== undefined ? byName.get(input.movement) : movements.length === 1 ? movements[0] : undefined;
  if (movement === undefined) return { mode: 'live' };

  const writes: Array<{ dry: boolean; span: Span }> = [];

  // Each body has its own alias scope. `handleOwner` maps a bound name (a
  // prior write's result, or a traversal-head alias) to the instance that owns
  // it; a name it does not hold is its own owner.
  const walkBody = (statements: readonly Statement[], handleOwner: Map<string, string>): void => {
    const resolveOwner = (name: string): string => handleOwner.get(name) ?? name;
    const registerHeadAliases = (head: PathHead): void => {
      const owner = headOwner({ head, handleOwner, resolveOwner, pin });
      if (owner === undefined) return;
      for (const alias of hopAliasesOf(head.hopsRaw)) handleOwner.set(alias, owner);
    };

    const ownerOf = (write: WriteExpression): string | undefined => {
      // A member-path root (`write m.k { … }`) is owned by no instance.
      const first = write.target.kind === 'linked' ? write.target.path : write.target.kind === 'tuple' ? write.target.paths[0] : write.target;
      const root = first !== undefined ? pathRootName(first) : undefined;
      return root !== undefined ? resolveOwner(root) : undefined;
    };

    const recordWrite = (write: WriteExpression, bindingName?: string): void => {
      const owner = ownerOf(write);
      writes.push({ dry: owner !== undefined && dryInstances.has(owner), span: write.span });
      if (bindingName !== undefined && owner !== undefined) handleOwner.set(bindingName, owner);
    };

    for (const statement of statements) {
      switch (statement.kind) {
        case 'write':
          recordWrite(statement.write);
          break;
        case 'assign':
          if (statement.value.kind === 'write') {
            recordWrite(statement.value.write, statement.name);
          } else if (statement.value.kind === 'construct') {
            recordConstruction(statement.name, statement.value.construct);
          } else if (statement.value.kind === 'block') {
            registerHeadAliases(statement.value.block.head);
            walkBody(statement.value.block.body, handleOwner);
          }
          break;
        case 'block':
          registerHeadAliases(statement.block.head);
          walkBody(statement.block.body, handleOwner);
          break;
        case 'if':
          for (const arm of statement.arms) walkBody(arm.body, handleOwner);
          if (statement.elseArm) walkBody(statement.elseArm.body, handleOwner);
          break;
        case 'call': {
          // A write factored into a called function still counts. The callee
          // has its own alias scope; write-typed arguments stay in the caller's.
          for (const arg of statement.args) {
            if (arg.kind === 'write') recordWrite(arg.write);
          }
          // Function names are case-insensitive, and two that differ only by
          // case are refused, so folding finds the one.
          const callee = byName.get(statement.callee) ?? movements.find((m) => m.name.toLowerCase() === statement.callee.toLowerCase());
          if (callee !== undefined && !calling.has(callee.name)) {
            calling.add(callee.name);
            walkBody(callee.body, new Map());
            calling.delete(callee.name);
          }
          break;
        }
        // None of these holds a write the scan follows: a write nested in an
        // expression is outside the platform's scan, as it was at 0.15.3.
        case 'import':
        case 'shape':
        case 'type':
        case 'movement':
        case 'listen':
        case 'match':
        case 'link':
        case 'unlink':
        case 'delete':
        case 'refresh':
        case 'await':
        case 'combinator':
        case 'collection':
        case 'return':
        case 'error':
          break;
        default: {
          const unscanned: never = statement;
          throw new Error(`a statement the run mode scan does not know: ${JSON.stringify(unscanned)}`);
        }
      }
    }
  };
  const calling = new Set<string>([movement.name]);
  walkBody(movement.body, new Map());

  if (writes.length === 0 || writes.every((w) => !w.dry)) return { mode: 'live' };
  if (writes.every((w) => w.dry)) return { mode: 'dry_run' };
  const conflicting = writes.find((w) => w.dry !== writes[0]?.dry);
  const at = conflicting ?? writes[0];
  return at === undefined ? { mode: 'live' } : { mode: 'mixed', span: at.span };
}
