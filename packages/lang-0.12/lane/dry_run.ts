// Production's scan at 0.12.13 (`movement/dry_run.ts` on main), with the two
// checker helpers it read beside it, over 0.12's own tree: which of a text's
// movements only rehearse.
//
// The universal `dry_run` construction parameter — write run-mode
// derivation, pure AST (no catalog needed: `dry_run` is a platform
// argument, so construction + write-target shape is enough). Used twice:
//   - by `saveMovement`'s listener reconciliation, to derive each derived
//     trigger's dry_run⇄live run_mode from the text;
//   - by the run-now executor, to re-derive the dry-run flag from the
//     SAVED source at invocation time.
//
// Dry-run is movement-level (6_engine.md): the engine takes one dryRun
// switch per run, so the whole movement is 'dry_run' exactly when EVERY
// written-to instance was constructed `dry_run: true`. Mixed dry/live
// instances surface as 'mixed' with the offending write's span.

import { expressionOfSlot, parseProgram, pathRootName, scanName } from '@listen-fire/movement-lang';

import type {
  ConstructionCall,
  MovementDeclaration,
  PathHead,
  Program,
  Span,
  Statement,
  WriteExpression,
} from '@listen-fire/movement-lang';
import { listElementExpression, objectMemberExpression, type Expression, type TraversalStep } from '@listen-fire/movement-lang/expression/types';

/**
 * A traversal-head alias inherits its owning instance from the head's
 * root — `slackbot-[ch:Channels …]->` makes `ch` owned by whatever owns
 * `slackbot`. Registered before the block body is walked so an
 * edge-anchored write off the alias resolves to the right instance. A
 * rootless head (`_resources`-style) leaves its aliases owner-unknown.
 *
 * A head rooted at an EXPRESSION (`AT(rows, 0)-[c:company]->`) has no name to
 * inherit from, so the owner is read off the names the expression READS: the
 * records it hands back came from those. One agreed owner is the answer; two
 * that disagree, or none that is known, leaves the aliases owner-unknown,
 * exactly as a rootless head does — this scan claims an owner only where the
 * text says one.
 */
function headOwner(
  head: PathHead,
  handleOwner: Map<string, string>,
  resolveOwner: (name: string) => string,
): string | undefined {
  const root = head.root;
  if (root === undefined) return undefined;
  if (root.kind === 'name') return resolveOwner(root.name);
  let names: Set<string>;
  try {
    names = new Set(collectExpressionNames(expressionOfSlot(root.expr)).refs);
  } catch {
    return undefined; // unparseable — the checker owns that diagnostic
  }
  const owners = new Set(
    [...names].filter((name) => handleOwner.has(name)).map((name) => resolveOwner(name)),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

function registerHeadAliases(
  head: PathHead,
  handleOwner: Map<string, string>,
  resolveOwner: (name: string) => string,
): void {
  const owner = headOwner(head, handleOwner, resolveOwner);
  if (owner === undefined) return;
  for (const alias of extractHopAliases(head.hopsRaw)) {
    handleOwner.set(alias, owner);
  }
}

export type MovementWriteRunMode =
  | { mode: 'live' | 'dry_run' }
  | { mode: 'mixed'; span: Span };

/**
 * Which run-mode a movement's writes imply, from the AST alone.
 *
 * A write's owning instance is its target instance, or — for linked
 * writes — the instance that produced the parent handle. Writes whose
 * owner is not a `dry_run: true` construction (including `kg`, which is
 * never constructed) count as live.
 */
export function movementWriteRunMode(
  program: Program,
  movementName: string | undefined,
): MovementWriteRunMode {
  const dryInstances = new Set<string>();
  const recordConstruction = (name: string, construct: ConstructionCall): void => {
    const dryArg = construct.args.find((a) => a.name === 'dry_run');
    if (dryArg !== undefined && dryArg.value.raw.trim().toLowerCase() === 'true') {
      dryInstances.add(name);
    }
  };
  const collectConstructions = (statements: Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'assign' && statement.value.kind === 'construct') {
        recordConstruction(statement.name, statement.value.construct);
      }
    }
  };
  collectConstructions(program.statements);

  const movements = program.statements.filter(
    (s): s is MovementDeclaration => s.kind === 'movement',
  );
  const byName = new Map(movements.map((m) => [m.name, m]));
  const movement = movementName
    ? byName.get(movementName)
    : movements.length === 1
      ? movements[0]
      : undefined;
  if (!movement) return { mode: 'live' };

  const writes: Array<{ dry: boolean; span: Span }> = [];

  // Each movement body has its own alias scope. `handleOwner` maps a
  // bound name — a prior write result, or a traversal-head alias — to the
  // instance that owns it, so an edge-anchored write (`slackbot-[ch:…]->
  // { write ch-[:messages]-> … }`) is attributed to `slackbot`. A name
  // that resolves to no tracked alias is its own owner: a write rooted
  // directly on an instance name resolves to that instance.
  const walkBody = (statements: Statement[], handleOwner: Map<string, string>): void => {
    const resolveOwner = (name: string): string => handleOwner.get(name) ?? name;

    const ownerOf = (write: WriteExpression): string | undefined => {
      // A member-path root (`write m.k { … }`) is owned by no instance, as
      // the `x` of `x = m.k` then `write x { … }` is not.
      const first = write.target.kind === 'linked' ? write.target.path : write.target.kind === 'tuple' ? write.target.paths[0] : write.target;
      const root = first !== undefined ? pathRootName(first) : undefined;
      return root !== undefined ? resolveOwner(root) : undefined;
    };

    const recordWrite = (write: WriteExpression, bindingName?: string): void => {
      const owner = ownerOf(write);
      writes.push({ dry: owner !== undefined && dryInstances.has(owner), span: write.span });
      if (bindingName !== undefined && owner !== undefined) {
        handleOwner.set(bindingName, owner);
      }
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
            registerHeadAliases(statement.value.block.head, handleOwner, resolveOwner);
            walkBody(statement.value.block.body, handleOwner);
          }
          break;
        case 'block':
          registerHeadAliases(statement.block.head, handleOwner, resolveOwner);
          walkBody(statement.block.body, handleOwner);
          break;
        case 'if':
          for (const arm of statement.arms) walkBody(arm.body, handleOwner);
          if (statement.elseArm) walkBody(statement.elseArm.body, handleOwner);
          break;
        case 'call': {
          // A write factored into a called movement (`Manual() { Run() }`,
          // Run holding the write) still counts. The callee has its own
          // alias scope; write-typed call arguments stay in the caller's.
          for (const arg of statement.args) {
            if (arg.kind === 'write') recordWrite(arg.write);
          }
          // Function names are case-insensitive from legacy version 3, and
          // two that differ only by case are refused, so folding finds the one.
          const callee = byName.get(statement.callee)
            ?? movements.find((m) => m.name.toLowerCase() === statement.callee.toLowerCase());
          if (callee !== undefined && !calling.has(callee.name)) {
            calling.add(callee.name);
            walkBody(callee.body, new Map());
            calling.delete(callee.name);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  const calling = new Set<string>([movement.name]);
  walkBody(movement.body, new Map());

  if (writes.length === 0 || writes.every((w) => !w.dry)) return { mode: 'live' };
  if (writes.every((w) => w.dry)) return { mode: 'dry_run' };
  const conflicting = writes.find((w) => w.dry !== writes[0].dry);
  return { mode: 'mixed', span: (conflicting ?? writes[0]).span };
}

// ── From 0.12's checker: the names an expression reads, and a head's hop aliases ─

interface CollectedNames {
  /** `traverse.aliasRoot` and `alias_ref` names — these resolve against statement scope. */
  refs: string[];
  /** Aliases bound by traversal steps within the same expression (locally resolved). */
  aliases: Set<string>;
  /** Every ROOTED read, as its root and the member names it reaches for
   *  (`x-[v:n]->.f` ⇒ root `x`, members `n`, `f`). What a read is FOR, rather
   *  than which names it mentions — the retired block read-back is diagnosed
   *  off this. */
  rooted: Array<{ root: string; members: string[] }>;
}

function collectFromSteps(steps: TraversalStep[], out: CollectedNames): void {
  for (const step of steps) {
    if (step.type === 'edge') {
      if (step.alias) out.aliases.add(step.alias);
      if (step.expressionFilter) collectNames(step.expressionFilter, out, 'field');
    } else if (step.type === 'meta_edge') {
      if (step.alias) out.aliases.add(step.alias);
      if (step.expressionFilter) collectNames(step.expressionFilter, out, 'field');
      const config = step.config;
      if (config) {
        if (config.description) collectNames(config.description, out, 'field');
        for (const d of config.data ?? []) collectNames(d, out, 'field');
        if (config.plugin) collectNames(config.plugin, out, 'field');
        for (const e of config.enrichWith ?? []) {
          collectNames(e.transform, out, 'field');
          collectNames(e.argument, out, 'field');
        }
        for (const v of Object.values(config.extra ?? {}) as Expression[]) collectNames(v, out, 'field');
      }
    }
  }
}

// A name's *position* decides whether a rootless spelling is a variable or a
// field. In `value` position (an interpolated `${foo}`, an `AI(foo)` prompt, a
// `COALESCE(foo, …)` arg) a bare name is a reference to resolve against scope.
// In `field` position — the tail of a traversal (`msg.`subject``), a step
// filter, an extract-config slot — it is a field of the traversal head, typed
// against the head's schema, so it is NOT a name to resolve here. (Backticks
// are just whitespace-safe quoting and don't change this; position does.)
type NamePosition = 'value' | 'field' | 'member';

function collectNames(expr: Expression, out: CollectedNames, position: NamePosition = 'value'): void {
  switch (expr.type) {
    case 'alias_ref':
      out.refs.push(expr.name);
      return;
    case 'traverse':
      // A dotted read's tail (`m.k.f`'s `k.f`) is rooted at a MEMBER of what
      // the head holds, not at a name in scope.
      if (expr.aliasRoot !== undefined && position !== 'member') {
        out.refs.push(expr.aliasRoot);
        out.rooted.push({ root: expr.aliasRoot, members: memberNames(expr) });
      }
      collectFromSteps(expr.steps, out);
      collectNames(expr.expression, out, expr.steps.length === 0 ? 'member' : 'field');
      return;
    case 'exists':
      collectFromSteps(expr.steps, out);
      if (expr.where) collectNames(expr.where, out, 'field');
      return;
    case 'resource_traverse':
      if (expr.expressionFilter) collectNames(expr.expressionFilter, out, 'field');
      collectNames(expr.expression, out, 'field');
      return;
    case 'llm':
      if (expr.promptExpression) collectNames(expr.promptExpression, out, 'value');
      return;
    case 'list':
      expr.elements.forEach(e => collectNames(listElementExpression(e), out, position));
      return;
    // An object literal's KEYS are the target API's own spelling, never names
    // to resolve; its values carry the position through unchanged.
    case 'object':
      expr.entries.forEach(e => collectNames(objectMemberExpression(e), out, position));
      return;
    case 'arithmetic':
    case 'compare':
      collectNames(expr.left, out, position);
      collectNames(expr.right, out, position);
      return;
    case 'logical':
      expr.operands.forEach(o => collectNames(o, out, position));
      return;
    case 'not':
    case 'negate':
      collectNames(expr.expression, out, position);
      return;
    case 'concat':
      expr.parts.forEach(p => collectNames(p, out, position));
      return;
    case 'conditional':
      collectNames(expr.condition, out, position);
      collectNames(expr.then, out, position);
      collectNames(expr.else, out, position);
      return;
    case 'at':
      collectNames(expr.expression, out, position);
      collectNames(expr.index, out, position);
      return;
    case 'aggregate':
      collectNames(expr.expression, out, position);
      return;
    case 'function':
      expr.args.forEach(a => collectNames(a, out, position));
      return;
    case 'kg_exists':
    case 'kg_value':
      expr.params.forEach(p => collectNames(p, out, position));
      return;
    case 'property':
      // A hop's alias read is a field, never a name to resolve.
      if (position === 'value' && expr.fieldOnly !== true) out.refs.push(expr.propertyTypeId);
      return;
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
      return;
  }
}

/** The member names a rooted read reaches for: each hop's edge name, then the
 *  property it lands on. */
function memberNames(expr: Extract<Expression, { type: 'traverse' }>): string[] {
  const members = expr.steps.flatMap((step) =>
    'edgeTypeId' in step && step.edgeTypeId !== undefined ? [step.edgeTypeId] : [],
  );
  if (expr.expression.type === 'property') members.push(expr.expression.propertyTypeId);
  return members;
}

function collectExpressionNames(expr: Expression): CollectedNames {
  const out: CollectedNames = { refs: [], aliases: new Set(), rooted: [] };
  collectNames(expr, out);
  return out;
}

// ── Traversal-head alias extraction ──
//
// Hop aliases (`-[c:companies]->`) must come from the raw hop text: a
// `_resources` head parses to `resource_traverse`, which carries neither
// alias nor root, so the probe AST alone would lose them.

function skipHeadString(text: string, start: number): number {
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

/** The alias opening a hop's interior (`c:` / `` `a b`: ``), read as every
 *  other name is. */
function hopAliasAt(hopsRaw: string, interiorStart: number): string | undefined {
  let i = interiorStart;
  while (i < hopsRaw.length && /\s/.test(hopsRaw[i])) i++;
  const scanned = scanName(hopsRaw, i);
  if (scanned === null) return undefined;
  let j = scanned.end;
  while (j < hopsRaw.length && /\s/.test(hopsRaw[j])) j++;
  return hopsRaw[j] === ':' ? scanned.name : undefined;
}

function extractHopAliases(hopsRaw: string): string[] {
  const aliases: string[] = [];
  let i = 0;
  while (i < hopsRaw.length) {
    const open = hopsRaw.indexOf('-[', i);
    if (open === -1) break;
    const interiorStart = open + 2;
    const alias = hopAliasAt(hopsRaw, interiorStart);
    if (alias !== undefined) aliases.push(alias);
    // Skip to the hop's closing ']' respecting nesting and literals.
    let depth = 1;
    let j = interiorStart;
    while (j < hopsRaw.length && depth > 0) {
      const ch = hopsRaw[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        j = skipHeadString(hopsRaw, j);
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


/** What a text's listen on `movementName` rehearses, read off its own parse:
 *  the text-derived half of a trigger row's run mode. */
export function writeRunModeOf(request: { source: string; pin: string; movementName: string }): 'live' | 'dry_run' {
  return movementWriteRunMode(parseProgram(request.source, { languageVersion: request.pin }), request.movementName).mode === 'dry_run' ? 'dry_run' : 'live';
}
