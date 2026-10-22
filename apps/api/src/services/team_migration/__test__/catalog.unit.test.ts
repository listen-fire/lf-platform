import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  TEAM_PARAM,
  assertManifestCovers,
  paramsFor,
  tenancyPredicate,
  topologicalOrder,
} from '../catalog';
import { MANIFEST, PRODUCTS, qualified } from '../manifest';

/**
 * The pure half of the migration tool: what a tenant's rows ARE (the composed
 * predicate) and what order they can be written in. Both are the parts that,
 * when wrong, are wrong SILENTLY — an over-broad predicate reaches another
 * tenant and an under-broad one leaves rows behind, and neither throws.
 */

describe('tenancyPredicate', () => {
  it('matches the tenant root on its own id, not on a team_id it does not have', () => {
    expect(tenancyPredicate('core.team', 't')).toBe(`"t"."id" = ${TEAM_PARAM}`);
  });

  it('matches an ordinary table on team_id', () => {
    expect(tenancyPredicate('automations.movement', 't')).toBe(`"t"."team_id" = ${TEAM_PARAM}`);
  });

  it('composes a via hop into a subquery over the parent’s own predicate', () => {
    const sql = tenancyPredicate('valuations.investment_attribution', 't');
    expect(sql).toContain('"t"."investment_id" IN (SELECT "p0"."id"');
    expect(sql).toContain('"valuations"."investment" "p0"');
    expect(sql).toContain(`"p0"."team_id" = ${TEAM_PARAM}`);
  });

  it('composes a multi-hop chain — a phone reaches the team through its user’s membership', () => {
    const sql = tenancyPredicate('automations.phone_number', 't');
    expect(sql).toContain('"core"."user" "p0"');
    expect(sql).toContain('"core"."team_membership" "p1"');
    expect(sql).toContain(`"p1"."team_id" = ${TEAM_PARAM}`);
  });

  it('takes the deployment’s shared rows when EXPORTING a table that holds both', () => {
    expect(tenancyPredicate('valuations.asset', 't')).toBe(
      `("t"."team_id" = ${TEAM_PARAM} OR "t"."team_id" IS NULL)`,
    );
  });

  it('does NOT take them when DELETING — reference data is shared, and one tenant leaving must not remove it', () => {
    expect(tenancyPredicate('valuations.asset', 't', { forDelete: true })).toBe(
      `"t"."team_id" = ${TEAM_PARAM}`,
    );
  });

  it('spares a user who also belongs to another team, but only on delete', () => {
    const onExport = tenancyPredicate('core.user', 't');
    const onDelete = tenancyPredicate('core.user', 't', { forDelete: true });
    expect(onExport).not.toContain('shared');
    expect(onDelete).toContain('NOT EXISTS');
    expect(onDelete).toContain(`shared.team_id <> ${TEAM_PARAM}`);
  });

  it('inherits that sparing through the traversal, so a shared user’s email survives too', () => {
    expect(tenancyPredicate('core.user_email', 't', { forDelete: true })).toContain('NOT EXISTS');
    expect(tenancyPredicate('core.user_email', 't')).not.toContain('NOT EXISTS');
  });

  it('reads TRUE for reference data, which is why the team id must not be bound to it', () => {
    const sql = tenancyPredicate('valuations.exchange_rate', 't');
    expect(sql).toBe('TRUE');
    expect(paramsFor(sql, 'a-team')).toEqual([]);
    expect(paramsFor(`"t"."team_id" = ${TEAM_PARAM}`, 'a-team')).toEqual(['a-team']);
  });
});

describe('topologicalOrder', () => {
  it('puts parents before children and breaks ties by name, so two runs agree', () => {
    const fks = new Map([
      ['s.child', new Set(['s.parent'])],
      ['s.grandchild', new Set(['s.child'])],
    ]);
    expect(topologicalOrder(['s.grandchild', 's.child', 's.parent', 's.alone'], fks)).toEqual([
      's.alone',
      's.parent',
      's.child',
      's.grandchild',
    ]);
  });

  it('refuses a cycle rather than picking an order that cannot work', () => {
    const fks = new Map([
      ['s.a', new Set(['s.b'])],
      ['s.b', new Set(['s.a'])],
    ]);
    expect(() => topologicalOrder(['s.a', 's.b'], fks)).toThrow(/cycle/i);
  });
});

describe('assertManifestCovers', () => {
  it('names a table nobody has ruled on', () => {
    expect(() => assertManifestCovers(['asks'], ['asks.ask', 'asks.something_new'])).toThrow(
      /asks\.something_new/,
    );
  });

  it('passes when every present table is declared', () => {
    expect(() => assertManifestCovers(['asks'], ['asks.ask'])).not.toThrow();
  });
});

describe('the manifest itself', () => {
  it('rules on each table exactly once', () => {
    for (const product of PRODUCTS) {
      const names = MANIFEST[product].map((spec) => qualified(product, spec));
      expect(names).toHaveLength(new Set(names).size);
    }
  });

  it('rules on every table the five unit schemas declare, so an export never refuses for want of one', () => {
    const schema = readFileSync(join(__dirname, '../../../db/schema.sql'), 'utf8');
    const present = PRODUCTS.flatMap((product) =>
      [...schema.matchAll(new RegExp(`^CREATE TABLE ${product}\\."?([a-z_]+)"? \\(`, 'gm'))].map((match) => `${product}.${match[1]}`),
    );
    expect(present).toEqual(expect.arrayContaining(['automations.work', 'automations.delivery', 'core.team']));
    expect(() => assertManifestCovers([...PRODUCTS], present)).not.toThrow();
  });

  it('gives every declined table a reason — a refusal without one is indistinguishable from an oversight', () => {
    for (const product of PRODUCTS) {
      for (const spec of MANIFEST[product]) {
        const reason = spec.outOfScopeBecause ?? spec.exportExcludedBecause;
        if (reason !== undefined) expect(reason.length).toBeGreaterThan(20);
      }
    }
  });
});
