// The calls Valuations' recorded parity makes, in order, against one
// implementation: the read surface (walkSurface: the two root collections and
// every field and edge two hops out, the down edges among them), the computed
// Valuations edge with its date and currency, entity resolution (exact,
// fuzzy, by website), an entity's create/read/update/delete, two commands
// with their parent links and the receipts they walk to, the inbound
// mapping for each subscribable event and for junk, the streamed root read
// (the snapshot underneath it), and the webhook subscription lifecycle. A
// second, shorter pass runs with no credential at all.

import type { Expression } from 'movement-lang/expression/types';
import type { Adapter } from 'movement-engine/public/adapter';

import { makeMetaPosition, makeStablePosition } from 'movement-engine/public/catalog';

import { MUTATION, Transcript, cmp, prop, value, walkSurface, type TranscriptEntry } from '../crm_parity/walk';

const ADAPTER_TYPE = 'native-valuations';

const and = (...operands: Expression[]): Expression => ({ type: 'logical', op: 'and', operands }) as Expression;

/** The secret a registration mints is random; parity holds its shape. */
function withSecretShape(answer: unknown): unknown {
  if (answer === null || typeof answer !== 'object' || !('secret' in answer)) return answer;
  const { secret } = answer as { secret: unknown };
  return { ...answer, secret: typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret) ? '<64 hex>' : secret };
}

async function collect<T>(iterable: AsyncIterable<T> | undefined): Promise<T[] | null> {
  if (iterable === undefined) return null;
  const all: T[] = [];
  for await (const item of iterable) all.push(item);
  return all;
}

export async function runValuationsParityScript(adapter: Adapter): Promise<TranscriptEntry[]> {
  const t = new Transcript();
  const firsts = await walkSurface(t, adapter, ADAPTER_TYPE, {
    extraTypes: ['Investment', 'Transaction', 'Asset Transfer', 'Price', 'Event', 'Valuation', 'AddMarkdown', 'AddInvestment', 'native-valuations:webhook_event'],
    depth: 2,
  });

  const meta = makeMetaPosition(ADAPTER_TYPE);
  const entity = (id: string, recordType: string, data: Record<string, unknown>) =>
    makeStablePosition({ adapterType: ADAPTER_TYPE, recordId: id, recordType, data: { id, ...data } });
  const acme = firsts.get('Legal Entity') !== undefined ? entity('le-acme', 'Legal Entity', { name: 'Acme Robotics' }) : undefined;
  const asOf = and(cmp(prop('date'), 'eq', value('2026-09-30')), cmp(prop('currency'), 'eq', value('EUR')));
  if (acme !== undefined) {
    await t.step('Legal Entity -[Valuations WHERE date AND currency]->', () =>
      adapter.getRelated({ position: acme, fieldId: 'Valuations', direction: 'outgoing', where: asOf }),
    );
    await t.step('Legal Entity -[Valuations WHERE date only]->', () =>
      adapter.getRelated({ position: acme, fieldId: 'Valuations', direction: 'outgoing', where: cmp(prop('date'), 'eq', value('2026-09-30')) }),
    );
  }
  await t.step('Investment -[Valuations WHERE currency AND date]->', () =>
    adapter.getRelated({
      position: entity('inv-1', 'Investment', { investor_profile_id: 'le-fund', investment_profile_id: 'le-acme' }),
      fieldId: 'Valuations',
      direction: 'outgoing',
      where: and(cmp(value('USD'), 'eq', prop('currency')), cmp(prop('date'), 'eq', value('2026-06-30'))),
    }),
  );
  await t.step('Investment -[Transactions]->', () =>
    adapter.getRelated({ position: entity('inv-1', 'Investment', {}), fieldId: 'Transactions', direction: 'outgoing' }),
  );
  await t.step('Asset -[Prices]->', () => adapter.getRelated({ position: entity('asset-1', 'Asset', {}), fieldId: 'Prices', direction: 'outgoing' }));

  await t.step('resolveEntity Legal Entity by Name', () =>
    adapter.resolveEntity({ record: { Name: 'Acme Robotics' }, recordType: 'Legal Entity', candidates: [], constraints: { any: [{ all: [{ field: 'Name' }] }] } } as never),
  );
  await t.step('resolveEntity Legal Entity FUZZY Name', () =>
    adapter.resolveEntity({ record: { Name: 'acme' }, recordType: 'Legal Entity', candidates: [], constraints: { any: [{ all: [{ field: 'Name', fuzzy: true }] }] } } as never),
  );
  await t.step('resolveEntity Legal Entity by Website or Name', () =>
    adapter.resolveEntity({
      record: { Name: 'Beta Labs', Website: 'https://beta.example/' },
      recordType: 'Legal Entity',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Website' }] }, { all: [{ field: 'Name' }] }] },
    } as never),
  );
  await t.step('resolveEntity FUZZY on a field that does not take it', () =>
    adapter.resolveEntity({ record: { Email: 'x@acme.example' }, recordType: 'Legal Entity', candidates: [], constraints: { any: [{ all: [{ field: 'Email', fuzzy: true }] }] } } as never),
  );

  const created = await t.step('createRecord Legal Entity', () =>
    adapter.createRecord({ recordType: 'Legal Entity', fields: { Name: 'Parity Labs', Type: 'PORTFOLIO_COMPANY', Description: null }, mutationContext: MUTATION }),
  );
  const createdId = created?.externalId;
  if (createdId !== undefined) {
    await t.step('readRecord Legal Entity', () => adapter.readRecord?.({ recordType: 'Legal Entity', externalId: createdId }) ?? null);
    await t.step('readRecord Legal Entity Name and Type', () =>
      adapter.readRecord?.({ recordType: 'Legal Entity', externalId: createdId, fieldIds: ['Name', 'Type'] }) ?? null,
    );
    await t.step('updateRecord Legal Entity', () =>
      adapter.updateRecord({ recordType: 'Legal Entity', externalId: createdId, fields: { Description: 'Made by recorded parity' }, mutationContext: MUTATION }),
    );
    const investment = await t.step('createRecord Investment under two parents', () =>
      adapter.createRecord({
        recordType: 'Investment',
        fields: { 'Round Type': 'SEED', 'Invested At': '2026-09-01' },
        parentLinks: [
          { recordType: 'Legal Entity', externalId: createdId, edgeName: 'Investments' },
          { recordType: 'Legal Entity', externalId: 'le-fund', edgeName: 'Investments Made' },
        ],
        mutationContext: MUTATION,
      }),
    );
    const investmentId = investment?.externalId;
    if (investmentId !== undefined) {
      await t.step('updateRecord Investment naming the parent it has', () =>
        adapter.updateRecord({
          recordType: 'Investment',
          externalId: investmentId,
          fields: {},
          parentLinks: [{ recordType: 'Legal Entity', externalId: 'le-fund', edgeName: 'Investments Made' }],
          mutationContext: MUTATION,
        }),
      );
      await t.step('updateRecord Investment naming another parent', () =>
        adapter.updateRecord({
          recordType: 'Investment',
          externalId: investmentId,
          fields: { Verified: true },
          parentLinks: [{ recordType: 'Legal Entity', externalId: 'le-beta', edgeName: 'Investments' }],
          mutationContext: MUTATION,
        }),
      );
    }
    await t.step('createRecord Event along the wrong edge', () =>
      adapter.createRecord({
        recordType: 'Event',
        fields: { Type: 'MARKDOWN' },
        parentLinks: [{ recordType: 'Legal Entity', externalId: createdId, edgeName: 'Assets' }],
        mutationContext: MUTATION,
      }),
    );
    await t.step('deleteRecord Legal Entity', () => adapter.deleteRecord({ recordType: 'Legal Entity', externalId: createdId, mutationContext: MUTATION }));
    await t.step('updateRecord Legal Entity after its delete', () =>
      adapter.updateRecord({ recordType: 'Legal Entity', externalId: createdId, fields: { Name: 'Gone' }, mutationContext: MUTATION }),
    );
    await t.step('readRecord Legal Entity after its delete', () => adapter.readRecord?.({ recordType: 'Legal Entity', externalId: createdId }) ?? null);
  }

  const markdown = await t.step('createRecord AddMarkdown', () =>
    adapter.createRecord({
      recordType: 'AddMarkdown',
      fields: { Date: '2026-09-30', Percentage: 25, Note: 'Recorded parity markdown' },
      parentLinks: [{ recordType: 'Legal Entity', externalId: 'le-acme', edgeName: 'AddMarkdown' }],
      mutationContext: MUTATION,
    }),
  );
  if (markdown !== undefined) {
    const receipt = makeStablePosition({ adapterType: ADAPTER_TYPE, recordId: markdown.externalId, recordType: 'AddMarkdown', data: markdown.data ?? {} });
    await t.step('AddMarkdown receipt -[Event]->', () => adapter.getRelated({ position: receipt, fieldId: 'Event', direction: 'outgoing' }));
    await t.step('AddMarkdown receipt -[Prices]->', () => adapter.getRelated({ position: receipt, fieldId: 'Prices', direction: 'outgoing' }));
  }
  const investmentCommand = await t.step('createRecord AddInvestment', () =>
    adapter.createRecord({
      recordType: 'AddInvestment',
      fields: { Date: '2026-09-15', Amount: 250000, Currency: 'EUR', 'Round Name': 'Seed+', Valuation: null },
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'le-acme', edgeName: 'AddInvestment' },
        { recordType: 'Legal Entity', externalId: 'le-fund', edgeName: 'Investor' },
      ],
      mutationContext: MUTATION,
    }),
  );
  if (investmentCommand !== undefined) {
    const receipt = makeStablePosition({ adapterType: ADAPTER_TYPE, recordId: investmentCommand.externalId, recordType: 'AddInvestment', data: investmentCommand.data ?? {} });
    for (const edge of ['Investment', 'Round', 'Transaction']) {
      await t.step(`AddInvestment receipt -[${edge}]->`, () => adapter.getRelated({ position: receipt, fieldId: edge, direction: 'outgoing' }));
    }
  }
  await t.step('createRecord AddInvestment without its investor', () =>
    adapter.createRecord({
      recordType: 'AddInvestment',
      fields: { Date: '2026-09-15' },
      parentLinks: [{ recordType: 'Legal Entity', externalId: 'le-acme', edgeName: 'AddInvestment' }],
      mutationContext: MUTATION,
    }),
  );
  await t.step('createRecord AddDividends', () =>
    adapter.createRecord({
      recordType: 'AddDividends',
      fields: { Date: '2026-09-20', Amount: 1000, Currency: 'EUR' },
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'le-acme', edgeName: 'AddDividends' },
        { recordType: 'Legal Entity', externalId: 'le-fund', edgeName: 'Recipient' },
      ],
      mutationContext: MUTATION,
    }),
  );

  for (const [name, raw] of INBOUND) {
    const answer = await t.step(`preprocessInbound ${name}`, () => adapter.preprocessInbound?.({ raw }) ?? null);
    const event = answer?.events[0];
    if (event !== undefined && event.recordType !== undefined) {
      // The record the delivery is about, as the engine seeds it.
      const delivered = makeStablePosition({ adapterType: ADAPTER_TYPE, recordId: event.externalId ?? '', recordType: 'Legal Entity', data: event.payload });
      await t.step(`${name}: Name`, () => adapter.getFieldValue({ position: delivered, fieldId: 'Name' }));
      await t.step(`${name}: -[Events]->`, () => adapter.getRelated({ position: delivered, fieldId: 'Events', direction: 'outgoing' }));
    }
  }
  await t.step('listEventTypes', () => adapter.listEventTypes?.() ?? null);

  // The streamed root read, which pages the entity's whole collection.
  await t.step('iterateRelated root Legal Entity', () => collect(adapter.iterateRelated?.({ position: meta, fieldId: 'Legal Entity', direction: 'outgoing' })));
  await t.step('iterateRelated root Investment (reached through its parents)', () =>
    collect(adapter.iterateRelated?.({ position: meta, fieldId: 'Investment', direction: 'outgoing' })),
  );

  const callbackUrl = 'https://example.test/api/public/webhook-sync/native_valuations/sub-1';
  const registered = await t.step('ensureEventSubscription create', async () =>
    withSecretShape(await (adapter.ensureEventSubscription?.({ callbackUrl, events: ['valuations:legal_entity:create', 'valuations:legal_entity:update'] } as never) ?? null)),
  );
  const externalId = (registered as { externalId?: string } | null | undefined)?.externalId;
  if (externalId !== undefined) {
    await t.step('ensureEventSubscription unchanged', async () =>
      withSecretShape(
        await (adapter.ensureEventSubscription?.({
          callbackUrl,
          events: ['valuations:legal_entity:update', 'valuations:legal_entity:create'],
          current: { externalId, events: ['valuations:legal_entity:create', 'valuations:legal_entity:update'] },
        } as never) ?? null),
      ),
    );
    await t.step('ensureEventSubscription widened', async () =>
      withSecretShape(
        await (adapter.ensureEventSubscription?.({
          callbackUrl,
          events: ['valuations:legal_entity:create', 'valuations:legal_entity:delete'],
          current: { externalId, events: ['valuations:legal_entity:create'] },
        } as never) ?? null),
      ),
    );
    await t.step('removeEventSubscription', () => adapter.removeEventSubscription?.({ callbackUrl, externalId }) ?? null);
  }

  return t.entries;
}

/** What an implementation with no credential says: nothing reaches the API. */
export async function runValuationsWithoutCredentialScript(adapter: Adapter): Promise<TranscriptEntry[]> {
  const t = new Transcript();
  const acme = makeStablePosition({ adapterType: ADAPTER_TYPE, recordId: 'le-acme', recordType: 'Legal Entity', data: { id: 'le-acme' } });
  await t.step('getRelated Events', () => adapter.getRelated({ position: acme, fieldId: 'Events', direction: 'outgoing' }));
  await t.step('getRelated Investing Entity', () =>
    adapter.getRelated({ position: makeStablePosition({ adapterType: ADAPTER_TYPE, recordId: 'le-acme', recordType: 'Legal Entity', data: { id: 'le-acme', investing_entity_id: 'le-fund' } }), fieldId: 'Investing Entity', direction: 'outgoing' }),
  );
  await t.step('iterateRelated root Legal Entity', () =>
    collect(adapter.iterateRelated?.({ position: makeMetaPosition(ADAPTER_TYPE), fieldId: 'Legal Entity', direction: 'outgoing' })),
  );
  await t.step('resolveEntity', () =>
    adapter.resolveEntity({ record: { Name: 'Acme Robotics' }, recordType: 'Legal Entity', candidates: [], constraints: { any: [{ all: [{ field: 'Name' }] }] } } as never),
  );
  await t.step('createRecord Legal Entity', () =>
    adapter.createRecord({ recordType: 'Legal Entity', fields: { Name: 'Parity Labs', Type: 'FUND' }, mutationContext: MUTATION }),
  );
  await t.step('readRecord', () => adapter.readRecord?.({ recordType: 'Legal Entity', externalId: 'le-acme' }) ?? null);
  await t.step('ensureEventSubscription', () =>
    adapter.ensureEventSubscription?.({ callbackUrl: 'https://example.test/x', events: ['valuations:legal_entity:create'] } as never) ?? null,
  );
  await t.step('removeEventSubscription', () => adapter.removeEventSubscription?.({ callbackUrl: 'https://example.test/x', externalId: 'https://example.test/x' }) ?? null);
  return t.entries;
}

const delivery = (event: string, after: Record<string, unknown> | null, before: Record<string, unknown> | null = null) => ({
  event,
  timestamp: '2026-10-01T08:59:00.000Z',
  actor: { type: 'user', id: 'user-1' },
  data: { id: 'le-acme', before, after },
});

const ACME_ROW = { id: 'le-acme', name: 'Acme Robotics', type: 'PORTFOLIO_COMPANY', investing_entity_id: 'le-fund' };

const INBOUND: ReadonlyArray<[string, unknown]> = [
  ['legal_entity create', delivery('valuations:legal_entity:create', ACME_ROW)],
  ['legal_entity update', delivery('valuations:legal_entity:update', { ...ACME_ROW, name: 'Acme Robotics AG' }, ACME_ROW)],
  ['legal_entity delete', delivery('valuations:legal_entity:delete', null, ACME_ROW)],
  ['an api-token actor with no id', { ...delivery('valuations:legal_entity:update', ACME_ROW), actor: { type: 'api-token', id: null } }],
  ['not a delivery', { nope: true }],
  ['a delivery missing its data', { event: 'valuations:legal_entity:create', timestamp: 'now', actor: { type: 'system', id: null } }],
];
