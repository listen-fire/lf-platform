// What the platform host refuses to fire: a `resolved` hop (one whose WHERE
// the host lists the members of) whose edge the listen's last edge does not
// carry. Where the last edge carries it (Airtable's `Changes` carries its base
// and table, by `Name` and by `Id` alike), the judge fires from the arrival
// and the host lists the hop only to subscribe per base; where it does not,
// the host would fire under every member, so the save is refused.

import type { ListenPlan, PlanHop } from 'engine-contracts';

import { unfiredHere } from '../listen_plans';

const hop = (edge: string, from: string, to: string, more: Partial<PlanHop> = {}): PlanHop => ({ edge, from, to, judged: 'none', ...more });

/** A base-and-table-narrowed Airtable listen, its `Changes` carrying the base
 *  and table (`carries`), narrowed by `taken`. */
function airtable(taken: unknown): ListenPlan {
  return {
    movement: 'changed',
    connection: 'crm',
    adapter: 'airtable',
    carries: ['Bases', 'Tables'],
    hops: [
      hop('Bases', '', 'Base', { judged: 'resolved', taken }),
      hop('Tables', 'Base', 'Table', { judged: 'resolved', taken }),
      hop('Changes', 'Table', 'Change', { judged: 'arrival' }),
    ],
  };
}

const byName = { left: { type: 'edge_property', propertyTypeId: 'Name', fieldOnly: true }, op: 'eq', right: { type: 'static', value: 'Hiring' } };
const byId = { left: { type: 'edge_property', propertyTypeId: 'Id', fieldOnly: true }, op: 'eq', right: { type: 'static', value: 'appHiring' } };

describe('unfiredHere', () => {
  it('does not refuse an Airtable listen narrowed by base or table name — its Changes carries them', () => {
    expect(unfiredHere(airtable(byName))).toBeNull();
  });

  it('does not refuse one narrowed by base or table id — the same, an upgraded 0.12 automation', () => {
    expect(unfiredHere(airtable(byId))).toBeNull();
  });

  it('refuses a resolved hop the last edge does not carry — the host would fire under every member', () => {
    const uncarried: ListenPlan = { ...airtable(byName), carries: [] };
    const why = unfiredHere(uncarried);
    expect(why).toContain('`Bases`');
    expect(why).toContain('`Tables`');
    expect(why).toContain('this host cannot judge it');
  });

  it('does not refuse a listen with no resolved hop', () => {
    const plain: ListenPlan = {
      movement: 'changed',
      connection: 'crm',
      adapter: 'airtable',
      hops: [hop('Companies', '', 'Companies'), hop('Changes', 'Companies', 'Change', { judged: 'arrival' })],
    };
    expect(unfiredHere(plain)).toBeNull();
  });
});
