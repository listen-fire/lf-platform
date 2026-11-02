// The calls Attio's recorded parity makes, in order, against one
// implementation: the read surface (walkSurface), the record writes an
// author's movement makes (a company, a person under it, a note, updates,
// a delete), entity resolution, the inbound mapping and the actor it names,
// and the webhook subscription lifecycle. No call reads a record that does
// not exist (the client retries a 404 on a minutes-long backoff), and no
// file is uploaded (a multipart body carries a random boundary).

import type { Adapter } from 'movement-engine/public/adapter';

import { makeMetaPosition } from 'movement-engine/public/catalog';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

import { MUTATION, Transcript, cmp, prop, value, walkSurface, type TranscriptEntry } from '../crm_parity/walk';

export async function runAttioParityScript(adapter: Adapter): Promise<TranscriptEntry[]> {
  const t = new Transcript();
  const firsts = await walkSurface(t, adapter, 'attio', { extraTypes: ['Note', 'Task', 'Comment', 'Thread', 'File'] });
  const meta = makeMetaPosition('attio');
  const companiesEdge = [...firsts.keys()].find((name) => name === 'Companies') ?? 'Companies';
  await t.step('root Companies WHERE name', () =>
    adapter.getRelated({ position: meta, fieldId: companiesEdge, direction: 'outgoing', where: cmp(prop('name'), 'eq', value('Northwind')) }),
  );
  await t.step('root Companies WHERE name CONTAINS', () =>
    adapter.getRelated({ position: meta, fieldId: companiesEdge, direction: 'outgoing', where: cmp(prop('name'), 'contains', value('north')), limit: 2 }),
  );

  const company = await t.step('createRecord Companies', () =>
    adapter.createRecord({ recordType: 'Companies', fields: { name: 'Parity Labs', domains: ['paritylabs.example'] }, mutationContext: MUTATION }),
  );
  const companyId = company?.externalId;
  if (companyId !== undefined) {
    await t.step('readRecord Companies', () => adapter.readRecord?.({ recordType: 'Companies', externalId: companyId }) ?? null);
    await t.step('updateRecord Companies', () =>
      adapter.updateRecord({ recordType: 'Companies', externalId: companyId, fields: { description: 'Made by recorded parity' }, mutationContext: MUTATION }),
    );
    const person = await t.step('createRecord People under the company', () =>
      adapter.createRecord({
        recordType: 'People',
        fields: { name: 'Paula Parity', email_addresses: ['paula@paritylabs.example'] },
        parentLinks: [{ recordType: 'Companies', externalId: companyId, edgeName: 'company' }],
        mutationContext: MUTATION,
      }),
    );
    await t.step('createRecord Note on the company', () =>
      adapter.createRecord({
        recordType: 'Note',
        fields: { title: 'Parity', content_plaintext: 'A note from recorded parity' },
        parentLinks: [{ recordType: 'Companies', externalId: companyId, edgeName: 'Notes' }],
        mutationContext: MUTATION,
      }),
    );
    const personId = person?.externalId;
    if (personId !== undefined) {
      await t.step('readRecord People', () => adapter.readRecord?.({ recordType: 'People', externalId: personId }) ?? null);
    }
    await t.step('resolveEntity Companies by domain', () =>
      adapter.resolveEntity({ record: { name: 'Parity Labs', domains: ['paritylabs.example'] }, recordType: 'Companies', candidates: [], constraints: { any: [] } as never }),
    );
    await t.step('deleteRecord Companies', () => adapter.deleteRecord({ recordType: 'Companies', externalId: companyId, mutationContext: MUTATION }));
  }

  for (const [name, raw] of INBOUND) {
    const answer = await t.step(`preprocessInbound ${name}`, () => adapter.preprocessInbound?.({ raw }) ?? null);
    const arrival = answer?.arrivals[0];
    if (arrival !== undefined && 'landing' in arrival) {
      // The run trigger the arrival makes; who acted rides on it.
      const trigger = arrivalTriggerOf({ pipelineInputId: 'pipeline-input-parity', adapterType: 'attio', now: new Date('2026-10-01T09:00:00.000Z'), arrival });
      await t.step(`extractActor ${name}`, () => adapter.extractActor?.({ event: trigger }) ?? null);
      await t.step(`getActorCandidates ${name}`, () => adapter.getActorCandidates?.({ event: trigger }) ?? null);
    }
  }

  // One subscription per listenable edge (adapter protocol 2.6).
  const registered = await t.step('ensureEventSubscription create', () =>
    adapter.ensureEventSubscription?.({ edge: 'Changes', callbackUrl: 'https://example.test/api/public/webhook-sync/attio/sub-1' }) ?? null,
  );
  const externalId = registered?.externalId;
  if (externalId !== undefined) {
    await t.step('ensureEventSubscription held', () =>
      adapter.ensureEventSubscription?.({ edge: 'Changes', callbackUrl: 'https://example.test/x', current: { externalId } }) ?? null,
    );
    await t.step('removeEventSubscription', () => adapter.removeEventSubscription?.({ callbackUrl: 'https://example.test/x', externalId }) ?? null);
  }

  return t.entries;
}

const MEMBER_ACTOR = { type: 'workspace-member', id: '1' };

const INBOUND: ReadonlyArray<[string, unknown]> = [
  ['record.created by a member', { webhook_id: 'wh-1', events: [{ event_type: 'record.created', id: { workspace_id: 'w', object_id: 'companies', record_id: 'company-northwind' }, actor: MEMBER_ACTOR }] }],
  ['record.updated by the api', { webhook_id: 'wh-1', events: [{ event_type: 'record.updated', id: { workspace_id: 'w', object_id: 'companies', record_id: 'company-northwind', attribute_id: 'attr-1' }, actor: { type: 'api-token', id: 'token-1' } }] }],
  ['not a delivery', { nope: true }],
];
