// The calls Airtable's recorded parity makes, in order, against one
// implementation: the read surface (walkSurface), the record writes, the
// webhook lifecycle, and an inbound ping that pulls its payload feed. When
// recording, `inject` appends a change to the fake's feed before the ping
// (fake-channels' own admin call, made beside the adapter, not through it);
// replaying, the recorded feed answers the same pull.

import type { Adapter } from 'movement-engine/public/adapter';

import { makeMetaPosition } from 'movement-engine/public/catalog';

import { MUTATION, Transcript, cmp, firstPosition, prop, value, walkSurface, type TranscriptEntry } from '../../../__test__/crm_parity/walk';

const BASE = 'appTEST001';
const COMPANIES = 'tblCOMPANIES';

export type InjectChange = (input: { webhookId: string; body: Record<string, unknown> }) => Promise<void>;

export async function runAirtableParityScript(adapter: Adapter, scoped: Adapter | undefined, inject?: InjectChange): Promise<TranscriptEntry[]> {
  const t = new Transcript();
  // Writes first: the fake's tables start empty, and the walk should find rows.
  const created = await t.step('createRecord Companies', () =>
    adapter.createRecord({ recordType: 'Companies', fields: { Name: 'Parity Labs', Stage: 'Seed', Notes: 'Made by recorded parity' }, mutationContext: MUTATION }),
  );
  const id = created?.externalId;
  if (id !== undefined) {
    await t.step('createRecord Contacts linked to the company', () =>
      adapter.createRecord({ recordType: 'Contacts', fields: { 'Full Name': 'Paula Parity', Email: 'paula@paritylabs.example', Company: [id] }, mutationContext: MUTATION }),
    );
  }
  await walkSurface(t, adapter, 'airtable', { extraTypes: ['Base', 'Table', 'Companies', 'Contacts', 'Vendors'], depth: 3 });
  // The `base:` construction argument: an instance scoped to one base. A
  // subject that cannot be scoped (protocol 2 carries no construction
  // arguments) skips these steps.
  if (scoped !== undefined) {
    await t.step('scoped listEntryPoints', () => scoped.listEntryPoints());
    const companies = await t.step('scoped root Companies', () =>
      scoped.getRelated({ position: makeMetaPosition('airtable'), fieldId: 'Companies', direction: 'outgoing', limit: 5 }),
    );
    const company = firstPosition(companies);
    if (company !== undefined) {
      for (const field of ['Name', 'Stage', 'Notes']) {
        await t.step(`Companies[0].${field}`, () => adapter.getFieldValue({ position: company, fieldId: field }));
      }
    }
    const contact = firstPosition(
      await t.step('scoped root Contacts', () => scoped.getRelated({ position: makeMetaPosition('airtable'), fieldId: 'Contacts', direction: 'outgoing', limit: 5 })),
    );
    if (contact !== undefined) {
      await t.step('Contacts[0].Email', () => adapter.getFieldValue({ position: contact, fieldId: 'Email' }));
      await t.step('Contacts[0] -[Company]->', () => adapter.getRelated({ position: contact, fieldId: 'Company', direction: 'outgoing' }));
    }
  }
  if (id !== undefined) {
    await t.step('readRecord Companies', () => adapter.readRecord?.({ recordType: 'Companies', externalId: id }) ?? null);
    await t.step('updateRecord Companies', () =>
      adapter.updateRecord({ recordType: 'Companies', externalId: id, fields: { Stage: 'Series A' }, mutationContext: MUTATION }),
    );
    await t.step('resolveEntity Companies by Name', () =>
      adapter.resolveEntity({ record: { Name: 'Parity Labs' }, recordType: 'Companies', candidates: [], constraints: { any: [] } as never }),
    );
    if (scoped !== undefined) {
      await t.step('scoped root Companies WHERE Name', () =>
        scoped.getRelated({ position: makeMetaPosition('airtable'), fieldId: 'Companies', direction: 'outgoing', where: cmp(prop('Name'), 'eq', value('Parity Labs')) }),
      );
    }
    await t.step('deleteRecord Companies', () => adapter.deleteRecord({ recordType: 'Companies', externalId: id, mutationContext: MUTATION }));
  }

  // One subscription per listenable edge (adapter protocol 2.6): a table's
  // rows on Changes, the base's table names on Tables. The platform hears
  // them on a connection started at its base (a listen scoped by a hop's
  // record is refused at save), so they run on the scoped instance.
  if (scoped !== undefined) {
    const callbackUrl = 'https://example.test/api/public/webhook-sync/airtable/sub-1';
    const registered = await t.step('scoped ensureEventSubscription Changes', () => scoped.ensureEventSubscription?.({ edge: 'Changes', callbackUrl }) ?? null);
    const webhookId = registered?.externalId;
    if (webhookId !== undefined) {
      if (inject !== undefined) {
        await inject({ webhookId, body: { changeType: 'add', tableId: COMPANIES, recordId: 'recPARITY1', fields: { Name: 'Pinged Co', Stage: 'Seed' } } });
        await inject({ webhookId, body: { changeType: 'update', tableId: COMPANIES, recordId: 'recPARITY1', fields: { Stage: 'Series A' } } });
      }
      await t.step('scoped preprocessInbound ping', () => scoped.preprocessInbound?.({ raw: { base: { id: BASE }, webhook: { id: webhookId }, timestamp: '2026-10-01T09:00:00.000Z' } }) ?? null);
      await t.step('scoped preprocessInbound ping from the checkpoint', () =>
        scoped.preprocessInbound?.({ raw: { base: { id: BASE }, webhook: { id: webhookId } }, checkpoint: 2 }) ?? null,
      );
      await t.step('scoped preprocessInbound not a ping', () => scoped.preprocessInbound?.({ raw: { nope: true } }) ?? null);
      await t.step('scoped ensureEventSubscription Changes held', () => scoped.ensureEventSubscription?.({ edge: 'Changes', callbackUrl, current: { externalId: webhookId } }) ?? null);
      // 0.13.x types the removal without its edge, though the wire carries it.
      const removal = { edge: 'Changes', callbackUrl, externalId: webhookId };
      await t.step('scoped removeEventSubscription Changes', () => scoped.removeEventSubscription?.(removal) ?? null);
    }
    const tablesUrl = 'https://example.test/api/public/webhook-sync/airtable/sub-2';
    const tables = await t.step('scoped ensureEventSubscription Tables', () => scoped.ensureEventSubscription?.({ edge: 'Tables', callbackUrl: tablesUrl }) ?? null);
    if (tables?.externalId !== undefined) {
      const removal = { edge: 'Tables', callbackUrl: tablesUrl, externalId: tables.externalId };
      await t.step('scoped removeEventSubscription Tables', () => scoped.removeEventSubscription?.(removal) ?? null);
    }
  }
  return t.entries;
}
