// The few pure helpers the story projection took from production's checker at
// 0.12.13 (`legacy-lang/checker/{catalog,check,typing}.ts` at main), over 0.12's
// own trees.

import {
  listElementExpression,
  objectMemberExpression,
  type Expression,
  type TraversalStep,
} from '@listen-fire/movement-lang/expression/types';
import { neverAsAny, type Program, type SchemaFieldType } from '@listen-fire/movement-lang';

export function parseFieldTypeName(name: string | undefined): SchemaFieldType | undefined {
  switch (name) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'file':
    case 'json':
      return name;
    default:
      return undefined;
  }
}

/** Every refinement a program declares, by name. */
export function declaredTypesIn(program: Program): Map<string, SchemaFieldType> {
  const declared = new Map<string, SchemaFieldType>();
  for (const statement of program.statements) {
    if (statement.kind === 'type') declared.set(statement.name, { kind: 'enum', options: statement.options });
  }
  return declared;
}

export function maybeAbsent(type: SchemaFieldType | undefined): SchemaFieldType | undefined {
  if (type === undefined) return undefined;
  if (typeof type === 'string') {
    if (type === 'never') return 'absent';
    return { kind: 'maybeAbsent', of: type };
  }
  // Already partial: flatten rather than nest a second layer.
  return type.kind === 'maybeAbsent' ? type : { kind: 'maybeAbsent', of: type };
}

export interface CollectedNames {
  /** `traverse.aliasRoot` and `alias_ref` names: these resolve against statement scope. */
  refs: string[];
  /** Aliases bound by traversal steps within the same expression (locally resolved). */
  aliases: Set<string>;
}

type NamePosition = 'value' | 'field' | 'member';

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
        for (const v of Object.values(config.extra ?? {})) collectNames(v, out, 'field');
      }
    }
  }
}

function collectNames(expr: Expression, out: CollectedNames, position: NamePosition = 'value'): void {
  switch (expr.type) {
    case 'alias_ref':
      out.refs.push(expr.name);
      return;
    case 'traverse':
      if (expr.aliasRoot !== undefined && position !== 'member') out.refs.push(expr.aliasRoot);
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
      expr.elements.forEach((e) => collectNames(listElementExpression(e), out, position));
      return;
    case 'object':
      expr.entries.forEach((e) => collectNames(objectMemberExpression(e), out, position));
      return;
    case 'arithmetic':
    case 'compare':
      collectNames(expr.left, out, position);
      collectNames(expr.right, out, position);
      return;
    case 'logical':
      expr.operands.forEach((o) => collectNames(o, out, position));
      return;
    case 'not':
    case 'negate':
      collectNames(expr.expression, out, position);
      return;
    case 'concat':
      expr.parts.forEach((p) => collectNames(p, out, position));
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
      expr.args.forEach((a) => collectNames(a, out, position));
      return;
    case 'kg_exists':
    case 'kg_value':
      expr.params.forEach((p) => collectNames(p, out, position));
      return;
    case 'property':
      if (position === 'value' && expr.fieldOnly !== true) out.refs.push(expr.propertyTypeId);
      return;
    case 'edge_property':
    case 'static':
    case 'meta':
    case 'parent_result':
    case 'resource':
    case 'linked_object':
    case 'extract_value':
    case 'action_result':
      return;
    default:
      neverAsAny(expr);
  }
}

export function collectExpressionNames(expr: Expression): CollectedNames {
  const out: CollectedNames = { refs: [], aliases: new Set() };
  collectNames(expr, out);
  return out;
}
