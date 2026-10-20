import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { Expression } from '#shared/expression/types';
import type { ConstraintEntry } from '../uniqueness_constraints';

import {
  collectEdgeTypeIds,
  isEdgeToEntry,
  parseConstraintText,
  serializeConstraintEntries,
} from '../uniqueness_constraints';

// ── Test IDs ──

const ET_WORKS_AT = 'et-works-at' as EdgeTypeId;
const ET_DEAL_FOR = 'et-deal-for' as EdgeTypeId;
const PT_NAME = 'pt-name' as PropertyTypeId;
const PT_EMAIL = 'pt-email' as PropertyTypeId;
const PT_INVESTOR_NAME = 'pt-investor-name' as PropertyTypeId;

// ── Helpers ──

function propExpr(propTypeId: string): Expression {
  return { type: 'property', propertyTypeId: propTypeId };
}

function edgeExpr(edgeTypeId: string, direction: 'outgoing' | 'incoming' = 'outgoing'): Expression {
  return {
    type: 'traverse',
    steps: [{ type: 'edge', edgeTypeId, direction }],
    expression: { type: 'static', value: true },
  };
}

describe('collectEdgeTypeIds', () => {
  test('extracts edge type ID from traverse expression', () => {
    const ids = collectEdgeTypeIds(edgeExpr('et-123'));
    expect(ids).toEqual(['et-123']);
  });

  test('returns empty for property expression', () => {
    const ids = collectEdgeTypeIds(propExpr('pt-1'));
    expect(ids).toEqual([]);
  });

  test('extracts from nested function args', () => {
    const ids = collectEdgeTypeIds({
      type: 'function',
      fn: 'coalesce',
      args: [edgeExpr('et-1'), propExpr('pt-1')],
    });
    expect(ids).toEqual(['et-1']);
  });
});

// ── resolveExpressionInSubgraph ──

describe('isEdgeToEntry / discriminator', () => {
  test('returns true for edge_to entries', () => {
    const entry: ConstraintEntry = { kind: 'edge_to', ancestorName: 'round' };
    expect(isEdgeToEntry(entry)).toBe(true);
  });

  test('returns false for expression entries', () => {
    const entry: ConstraintEntry = { expr: propExpr(PT_INVESTOR_NAME as string) };
    expect(isEdgeToEntry(entry)).toBe(false);
  });

  test('returns false for fuzzy property entries', () => {
    const entry: ConstraintEntry = {
      expr: propExpr(PT_INVESTOR_NAME as string),
      fuzzy: true,
    };
    expect(isEdgeToEntry(entry)).toBe(false);
  });
});

// ── 2. Zod schema accepts both entry shapes ───────────────────────────────
describe('parseConstraintText', () => {
  const propertyByName = new Map([
    ['name', PT_NAME as string],
    ['email', PT_EMAIL as string],
  ]);

  const edgeByNodeTypeName = new Map([
    ['company', { id: ET_WORKS_AT as string, direction: 'outgoing' as const }],
    ['organisation', { id: ET_DEAL_FOR as string, direction: 'incoming' as const }],
  ]);

  test('parses single property', () => {
    const result = parseConstraintText('Name', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect((result.entries![0] as any).expr.type).toBe('property');
    expect((result.entries![0] as any).expr.propertyTypeId).toBe(PT_NAME);
  });

  test('parses fuzzy property', () => {
    const result = parseConstraintText('FUZZY(Name)', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect((result.entries![0] as any).fuzzy).toBe(true);
    expect((result.entries![0] as any).expr.type).toBe('property');
  });

  test('parses edge expression', () => {
    const result = parseConstraintText('-[:Company]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect((result.entries![0] as any).expr.type).toBe('traverse');
    const step = (result.entries![0] as any).expr.steps[0];
    expect(step.edgeTypeId).toBe(ET_WORKS_AT);
    expect(step.direction).toBe('outgoing');
  });

  test('parses incoming edge', () => {
    const result = parseConstraintText('-[:Organisation]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    const step = (result.entries![0] as any).expr.steps[0];
    expect(step.edgeTypeId).toBe(ET_DEAL_FOR);
    expect(step.direction).toBe('incoming');
  });

  test('parses compound AND expression', () => {
    const result = parseConstraintText(
      'FUZZY(Name) AND -[:Company]->',
      propertyByName,
      edgeByNodeTypeName,
    );
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect((result.entries![0] as any).fuzzy).toBe(true);
    expect((result.entries![0] as any).expr.type).toBe('property');
    expect((result.entries![1] as any).expr.type).toBe('traverse');
  });

  test('case-insensitive AND keyword', () => {
    const result = parseConstraintText('Name and Email', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(2);
  });

  test('case-insensitive property names', () => {
    const result = parseConstraintText('name', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect((result.entries![0] as any).expr.propertyTypeId).toBe(PT_NAME);
  });

  test('case-insensitive edge names', () => {
    const result = parseConstraintText('-[:company]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
  });

  test('fails on unknown property', () => {
    const result = parseConstraintText('UnknownProp', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown property or edge');
  });

  test('fails on unknown edge target', () => {
    const result = parseConstraintText('-[:NoSuchType]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown edge target');
  });

  test('fails on empty string', () => {
    const result = parseConstraintText('', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Empty');
  });

  test('fails on whitespace-only string', () => {
    const result = parseConstraintText('   ', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
  });

  test('case-insensitive FUZZY keyword', () => {
    const result = parseConstraintText('fuzzy(Name)', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect((result.entries![0] as any).fuzzy).toBe(true);
  });

  test('three-way AND', () => {
    const result = parseConstraintText(
      'Name AND Email AND -[:Company]->',
      propertyByName,
      edgeByNodeTypeName,
    );
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(3);
  });

  // N1: WITHIN(<dateProperty>, "<interval>") — time-window scope.
  describe('WITHIN', () => {
    const PT_FIRST_SEEN = 'pt-first-seen' as PropertyTypeId;
    const propertyByNameWithDate = new Map([
      ['name', PT_NAME as string],
      ['email', PT_EMAIL as string],
      ['first_seen', PT_FIRST_SEEN as string],
    ]);

    test('parses WITHIN with a 6-month interval into a function expression', () => {
      const result = parseConstraintText(
        'WITHIN(first_seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(1);
      const expr = (result.entries![0] as any).expr;
      expect(expr.type).toBe('function');
      expect(expr.fn).toBe('within');
      expect(expr.args).toHaveLength(2);
      expect(expr.args[0]).toEqual({
        type: 'property',
        propertyTypeId: PT_FIRST_SEEN,
      });
      expect(expr.args[1]).toEqual({ type: 'static', value: '6 months' });
    });

    test('accepts single-quoted intervals', () => {
      const result = parseConstraintText(
        "WITHIN(first_seen, '1 year')",
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.args[1].value).toBe('1 year');
    });

    test('accepts compound intervals (e.g. "1 year 3 months")', () => {
      const result = parseConstraintText(
        'WITHIN(first_seen, "1 year 3 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.args[1].value).toBe('1 year 3 months');
    });

    test('combines with AND alongside FUZZY property entries', () => {
      const result = parseConstraintText(
        'FUZZY(Name) AND WITHIN(first_seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(2);
      expect((result.entries![0] as any).fuzzy).toBe(true);
      expect((result.entries![1] as any).expr.type).toBe('function');
      expect((result.entries![1] as any).expr.fn).toBe('within');
    });

    test('case-insensitive WITHIN keyword', () => {
      const result = parseConstraintText(
        'within(first_seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.fn).toBe('within');
    });

    test('case-insensitive property name lookup', () => {
      const result = parseConstraintText(
        'WITHIN(First_Seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.args[0].propertyTypeId).toBe(PT_FIRST_SEEN);
    });

    test('fails on unknown property', () => {
      const result = parseConstraintText(
        'WITHIN(nonexistent, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unknown property');
    });
  });
});

// ── serializeConstraintEntries ──

describe('serializeConstraintEntries', () => {
  const propIdToName = new Map([
    [PT_NAME as string, 'Name'],
    [PT_EMAIL as string, 'Email'],
  ]);
  const edgeIdToTargetName = new Map([
    [ET_WORKS_AT as string, 'Company'],
  ]);
  const edgeIdToSourceName = new Map([
    [ET_DEAL_FOR as string, 'Organisation'],
  ]);

  test('serializes property entry', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr(PT_NAME as string) },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('Name');
  });

  test('serializes fuzzy property', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr(PT_NAME as string), fuzzy: true },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('FUZZY(Name)');
  });

  test('serializes outgoing edge', () => {
    const entries: ConstraintEntry[] = [
      { expr: edgeExpr(ET_WORKS_AT as string, 'outgoing') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('-[:Company]->');
  });

  test('serializes incoming edge using source name', () => {
    const entries: ConstraintEntry[] = [
      { expr: edgeExpr(ET_DEAL_FOR as string, 'incoming') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('-[:Organisation]->');
  });

  test('serializes compound AND', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr(PT_NAME as string), fuzzy: true },
      { expr: edgeExpr(ET_WORKS_AT as string, 'outgoing') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('FUZZY(Name) AND -[:Company]->');
  });

  test('falls back to truncated ID for unknown property', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr('unknown-property-type-id') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('unknown-');
  });

  test('round-trip: parse → serialize → parse produces same AST', () => {
    const propertyByName = new Map([
      ['name', PT_NAME as string],
      ['email', PT_EMAIL as string],
    ]);
    const edgeByNodeTypeName = new Map([
      ['company', { id: ET_WORKS_AT as string, direction: 'outgoing' as const }],
    ]);

    const original = 'FUZZY(Name) AND -[:Company]->';
    const parsed = parseConstraintText(original, propertyByName, edgeByNodeTypeName);
    expect(parsed.ok).toBe(true);

    const serialized = serializeConstraintEntries(
      parsed.entries!,
      propIdToName,
      edgeIdToTargetName,
      edgeIdToSourceName,
    );
    expect(serialized).toBe(original);

    // Parse again and verify same structure
    const reparsed = parseConstraintText(serialized, propertyByName, edgeByNodeTypeName);
    expect(reparsed.ok).toBe(true);
    expect(reparsed.entries).toEqual(parsed.entries);
  });

  // N1: WITHIN serializer round-trip.
  describe('WITHIN serialization', () => {
    const PT_FIRST_SEEN = 'pt-first-seen' as PropertyTypeId;
    const propIdToNameWithDate = new Map([
      [PT_NAME as string, 'Name'],
      [PT_EMAIL as string, 'Email'],
      [PT_FIRST_SEEN as string, 'first_seen'],
    ]);
    const propertyByNameWithDate = new Map([
      ['name', PT_NAME as string],
      ['email', PT_EMAIL as string],
      ['first_seen', PT_FIRST_SEEN as string],
    ]);
    const edgeByNodeTypeNameForWithin = new Map<
      string,
      { id: string; direction: 'outgoing' | 'incoming' }
    >([['company', { id: ET_WORKS_AT as string, direction: 'outgoing' }]]);

    test('serializes a WITHIN function expression back to text', () => {
      const entries: ConstraintEntry[] = [
        {
          expr: {
            type: 'function',
            fn: 'within',
            args: [
              { type: 'property', propertyTypeId: PT_FIRST_SEEN as string },
              { type: 'static', value: '6 months' },
            ],
          },
        },
      ];
      const text = serializeConstraintEntries(
        entries,
        propIdToNameWithDate,
        edgeIdToTargetName,
        edgeIdToSourceName,
      );
      expect(text).toBe('WITHIN(first_seen, "6 months")');
    });

    test('round-trips a WITHIN expression through parse → serialize', () => {
      const original = 'WITHIN(first_seen, "6 months")';
      const parsed = parseConstraintText(
        original,
        propertyByNameWithDate,
        edgeByNodeTypeNameForWithin,
      );
      expect(parsed.ok).toBe(true);
      const serialized = serializeConstraintEntries(
        parsed.entries!,
        propIdToNameWithDate,
        edgeIdToTargetName,
        edgeIdToSourceName,
      );
      expect(serialized).toBe(original);
    });

    test('round-trips a compound `FUZZY(Name) AND WITHIN(...)` expression', () => {
      const original = 'FUZZY(Name) AND WITHIN(first_seen, "1 year")';
      const parsed = parseConstraintText(
        original,
        propertyByNameWithDate,
        edgeByNodeTypeNameForWithin,
      );
      expect(parsed.ok).toBe(true);
      const serialized = serializeConstraintEntries(
        parsed.entries!,
        propIdToNameWithDate,
        edgeIdToTargetName,
        edgeIdToSourceName,
      );
      expect(serialized).toBe(original);
    });
  });
});

describe('parseConstraintText + serializeConstraintEntries (edge_to)', () => {
  test('parses edge_to:Name syntax', () => {
    const result = parseConstraintText(
      'edge_to:round',
      new Map(),
      new Map(),
    );
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(isEdgeToEntry(result.entries![0])).toBe(true);
    expect((result.entries![0] as { ancestorName: string }).ancestorName).toBe('round');
  });

  test('rejects edge_to with empty name', () => {
    const result = parseConstraintText(
      'edge_to:   ',
      new Map(),
      new Map(),
    );
    expect(result.ok).toBe(false);
  });

  test('serializes edge_to entries back to text', () => {
    const entries: ConstraintEntry[] = [
      { kind: 'edge_to', ancestorName: 'round' },
      { kind: 'edge_to', ancestorName: 'investor' },
    ];
    const text = serializeConstraintEntries(
      entries,
      new Map(),
      new Map(),
      new Map(),
    );
    expect(text).toBe('edge_to:round AND edge_to:investor');
  });

  test('mixed property + edge_to round-trips', () => {
    const propertyByName = new Map([['name', PT_INVESTOR_NAME as string]]);
    const result = parseConstraintText(
      'Name AND edge_to:round',
      propertyByName,
      new Map(),
    );
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(isEdgeToEntry(result.entries![0])).toBe(false);
    expect(isEdgeToEntry(result.entries![1])).toBe(true);
  });
});
