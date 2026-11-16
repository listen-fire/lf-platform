// Which row a wanted subscription takes over, with two carried versions: of its
// earlier names, newest first, the first a row holds is the place, moved when no
// other key reads that name and left where it is (copied) when one does. An older
// name is never tried past it.

jest.mock('@listen-fire/language-versions', () => {
  const actual = jest.requireActual('@listen-fire/language-versions');
  const carried = (key: string, release: string) => ({ key, release, provides: { listen: { kind: 'carried' } } });
  // In catalog order, the older first: the rule must not lean on it.
  return { ...actual, carriedVersions: () => [{ key: '0.16', release: '0.16.1', provides: { listen: { kind: 'current' } } }, carried('0.12', '0.12.4'), carried('0.15', '0.15.3')] };
});

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { listenEdgeDigest, type ListenEdgeKey } from '../../../inbound/listen_edge';
import { earlierRowToTake, type SubscriptionRow } from '../listen_subscriptions';

const PROVIDER = 'ACME_VENDOR';

/** A current key on a narrowed edge: named, under each carried version, by itself with that version. */
const key: ListenEdgeKey = {
  teamId: '00000000-0000-4000-8000-000000000001' as TeamId,
  adapterType: 'acme_vendor',
  credentialsId: null,
  constructionArgs: undefined,
  edge: 'Things',
  taken: { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'status' }, right: { type: 'static', value: 'open' } },
};
const under = (version: string) => listenEdgeDigest({ ...key, version });

function rowNamed(digest: string, id: string): SubscriptionRow {
  return { id, provider: PROVIDER, credentialsId: null, externalWebhookId: `ext-${id}`, secret: 'secret', held: { digest, edge: 'Things' }, legacyScope: {}, status: 'active' };
}

const take = (input: { rows: SubscriptionRow[]; readBesides?: string[]; carriedUnread?: string[] }) =>
  earlierRowToTake({
    subscription: { key, providerKey: PROVIDER },
    rows: input.rows,
    readBesides: new Set(input.readBesides ?? []),
    carriedUnread: new Set(input.carriedUnread ?? []),
  });

describe('the row a subscription takes over, with two carried versions', () => {
  const v015 = rowNamed(under('0.15'), 'row-015');
  const v012 = rowNamed(under('0.12'), 'row-012');

  it("takes the newest version's row, whatever the catalog's order", () => {
    expect(take({ rows: [v012, v015] })).toEqual({ row: v015, earlier: under('0.15') });
  });

  it("takes the older version's row when the newer left none", () => {
    expect(take({ rows: [v012] })).toEqual({ row: v012, earlier: under('0.12') });
  });

  it("leaves the newest row found where it is when another key reads its name, and does not fall through to the older one", () => {
    expect(take({ rows: [v012, v015], readBesides: [under('0.15')] })).toBeUndefined();
  });

  it("leaves the newest row found where it is when that version's listens could not be read", () => {
    expect(take({ rows: [v012, v015], carriedUnread: ['0.15'] })).toBeUndefined();
  });

  it("takes nothing on another provider's row", () => {
    expect(take({ rows: [{ ...v015, provider: 'OTHER' }] })).toBeUndefined();
  });

  it("a carried key's earlier names are tried newest first too: its name without being alone, then its name while its version was current", () => {
    const carried: ListenEdgeKey = { ...key, version: '0.15', alone: 'trigger-1' };
    const withoutAlone = listenEdgeDigest({ ...carried, alone: undefined });
    const asCurrent = listenEdgeDigest({ ...carried, version: undefined });
    const rows = [rowNamed(asCurrent, 'row-0153'), rowNamed(withoutAlone, 'row-0160')];
    const taking = (readBesides: string[]) =>
      earlierRowToTake({ subscription: { key: carried, providerKey: PROVIDER }, rows, readBesides: new Set(readBesides), carriedUnread: new Set() });
    expect(taking([])).toEqual({ row: rows[1], earlier: withoutAlone });
    expect(taking([withoutAlone])).toBeUndefined();
  });
});
