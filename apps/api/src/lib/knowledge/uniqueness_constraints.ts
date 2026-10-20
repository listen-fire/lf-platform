// A node type's uniqueness constraints as the knowledge graph stores them
// (an OR of AND-joined terms over its properties and edges), and the text
// form the ontology agent reads and writes them in.

import type { Expression, EdgeStep } from '#shared/expression/types';

// ── Types ──

/**
 * Expression-based constraint entry — the original shape. Carries an
 * `Expression` plus an optional `fuzzy` flag; resolved at search time
 * against extracted property values + resolved edge targets.
 */
interface ExpressionConstraintEntry {
  expr: Expression;
  fuzzy?: boolean;
}

/**
 * Compound-scope entry — references a named ancestor bound by an
 * ancestor action in the same translation graph. AND-tupled with all
 * other entries in the same constraint. Resolved at search time via
 * the `resolvedAncestorNodes` map: candidate must have an edge to the
 * resolved ancestor node.
 *
 */
interface EdgeToConstraintEntry {
  kind: 'edge_to';
  ancestorName: string;
}

type ConstraintEntry = ExpressionConstraintEntry | EdgeToConstraintEntry;

function isEdgeToEntry(entry: ConstraintEntry): entry is EdgeToConstraintEntry {
  return (entry as EdgeToConstraintEntry).kind === 'edge_to';
}

type UniquenessConstraint = ConstraintEntry[];
type StoredUniquenessConstraints = UniquenessConstraint[];

function collectEdgeTypeIds(expr: Expression): string[] {
  if (expr.type === 'traverse') {
    const ids: string[] = [];
    for (const step of expr.steps) {
      if (step.type === 'edge') ids.push(step.edgeTypeId);
    }
    return ids;
  }
  if (expr.type === 'function') return expr.args.flatMap(collectEdgeTypeIds);
  if (expr.type === 'arithmetic') return [...collectEdgeTypeIds(expr.left), ...collectEdgeTypeIds(expr.right)];
  if (expr.type === 'concat') return expr.parts.flatMap(collectEdgeTypeIds);
  return [];
}

// ── Constraint text format: parse & serialize ──

interface ConstraintParseResult {
  ok: boolean;
  entries?: ConstraintEntry[];
  error?: string;
}

function parseConstraintText(
  text: string,
  propertyByName: Map<string, string>,
  edgeByNodeTypeName: Map<string, { id: string; direction: 'outgoing' | 'incoming' }>,
): ConstraintParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Empty expression' };

  const parts = trimmed.split(/\s+AND\s+/i);
  const entries: ConstraintEntry[] = [];

  for (const raw of parts) {
    let part = raw.trim();
    if (!part) return { ok: false, error: 'Empty term in expression' };

    // Compound-scope: `edge_to:AncestorName` — bare-name reference to a
    // TG ancestor binding. Cannot be wrapped in FUZZY (resolution is
    // exact: edge exists or not).
    const edgeToMatch = part.match(/^edge_to:\s*(.+)$/i);
    if (edgeToMatch) {
      const ancestorName = edgeToMatch[1].trim();
      if (!ancestorName) return { ok: false, error: 'edge_to entry missing ancestor name' };
      entries.push({ kind: 'edge_to', ancestorName });
      continue;
    }

    // N1: time-window scope — `WITHIN(<dateProperty>, "<interval>")`.
    // The argument shape is `<bareName>, "<intervalString>"`; intervals
    // are quoted (single or double) Postgres interval strings ("6 months",
    // "1 year", "30 days", "1 year 3 months", …). Cannot be wrapped in
    // FUZZY — temporal-scope resolution is exact: the candidate's date
    // is in-range or not. Parser checks the structural shape; Postgres
    // catches malformed intervals at query time.
    const withinMatch = part.match(
      /^WITHIN\(\s*([^,]+?)\s*,\s*['"](.+?)['"]\s*\)$/i,
    );
    if (withinMatch) {
      const propName = withinMatch[1].trim();
      const intervalStr = withinMatch[2].trim();
      if (!propName) return { ok: false, error: 'WITHIN entry missing date property name' };
      if (!intervalStr) return { ok: false, error: 'WITHIN entry missing interval string' };
      const propId = propertyByName.get(propName.toLowerCase());
      if (!propId) return { ok: false, error: `Unknown property "${propName}" in WITHIN(...)` };
      entries.push({
        expr: {
          type: 'function',
          fn: 'within',
          args: [
            { type: 'property', propertyTypeId: propId } as Expression,
            { type: 'static', value: intervalStr } as Expression,
          ],
        } as Expression,
      });
      continue;
    }

    let fuzzy = false;
    const fuzzyMatch = part.match(/^FUZZY\((.+)\)$/i);
    if (fuzzyMatch) {
      fuzzy = true;
      part = fuzzyMatch[1].trim();
    }

    // Edge pattern: -[:Name]->
    const edgeMatch = part.match(/^-\[:(.+?)\]->$/);
    if (edgeMatch) {
      const name = edgeMatch[1].trim();
      const edge = edgeByNodeTypeName.get(name.toLowerCase());
      if (!edge) return { ok: false, error: `Unknown edge target "${name}"` };
      entries.push({
        expr: {
          type: 'traverse',
          steps: [{ type: 'edge', edgeTypeId: edge.id, direction: edge.direction } as EdgeStep],
          expression: { type: 'static', value: true } as Expression,
        } as Expression,
        ...(fuzzy ? { fuzzy: true } : {}),
      });
      continue;
    }

    // Property: bare name
    const propId = propertyByName.get(part.toLowerCase());
    if (propId) {
      entries.push({
        expr: { type: 'property', propertyTypeId: propId } as Expression,
        ...(fuzzy ? { fuzzy: true } : {}),
      });
      continue;
    }

    return { ok: false, error: `Unknown property or edge "${part}"` };
  }

  return { ok: true, entries };
}

function serializeConstraintEntries(
  entries: ConstraintEntry[],
  propIdToName: Map<string, string>,
  edgeIdToTargetName: Map<string, string>,
  edgeIdToSourceName: Map<string, string>,
): string {
  return entries
    .map((entry) => {
      if (isEdgeToEntry(entry)) {
        return `edge_to:${entry.ancestorName}`;
      }
      let token: string;
      const expr = entry.expr;
      if (expr.type === 'property' && expr.propertyTypeId) {
        token = propIdToName.get(expr.propertyTypeId) ?? expr.propertyTypeId.slice(0, 8);
      } else if (expr.type === 'traverse' && expr.steps?.[0]?.type === 'edge') {
        const step = expr.steps[0] as EdgeStep;
        const name =
          step.direction === 'incoming'
            ? edgeIdToSourceName.get(step.edgeTypeId)
            : edgeIdToTargetName.get(step.edgeTypeId);
        token = `-[:${name ?? step.edgeTypeId.slice(0, 8)}]->`;
      } else if (
        expr.type === 'function' &&
        expr.fn === 'within' &&
        expr.args.length === 2 &&
        expr.args[0].type === 'property' &&
        expr.args[1].type === 'static' &&
        typeof expr.args[1].value === 'string'
      ) {
        // N1: round-trip WITHIN(<dateProperty>, "<interval>") back to text.
        // Mirrors the parser at `parseConstraintText`; the interval is
        // quoted with double quotes for consistency with the canonical
        // surface syntax.
        const propId = expr.args[0].propertyTypeId;
        const propName = propIdToName.get(propId) ?? propId.slice(0, 8);
        const intervalStr = expr.args[1].value;
        token = `WITHIN(${propName}, "${intervalStr}")`;
      } else {
        token = expr.type;
      }
      return entry.fuzzy ? `FUZZY(${token})` : token;
    })
    .join(' AND ');
}

export { collectEdgeTypeIds, parseConstraintText, serializeConstraintEntries, isEdgeToEntry };

export type {
  ConstraintEntry,
  ExpressionConstraintEntry,
  EdgeToConstraintEntry,
  UniquenessConstraint,
  StoredUniquenessConstraints,
  ConstraintParseResult,
};
