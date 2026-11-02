// How `@lf/kg` reports a change in the graph: the arrival on the changed
// record's `Changes`, named the way writes name the record, and the change
// type a listen on it lands on.

import { makeStablePosition } from 'movement-engine/public/catalog';

import type { KgNode, KgStore, WireOntology } from '../store';

import { KnowledgeGraphAdapter } from '../adapter';
import { changeArrivals, describeChange } from '../changes';

const TICKET = '00000000-0000-4000-8000-0000000000a1';

const ONTOLOGY: WireOntology = {
  nodeTypes: [
    { id: 'nt-ticket', name: 'Support Ticket', description: null, category: null, displayNameTemplate: null, displayNameExpression: null, uniquenessConstraints: { any: [] } },
    { id: 'nt-person', name: 'Person', description: null, category: null, displayNameTemplate: null, displayNameExpression: null, uniquenessConstraints: { any: [] } },
  ],
  propertyTypes: [
    { id: 'pt-status', name: 'Status', description: null, nodeTypeId: 'nt-ticket', edgeTypeId: null, valueType: 'text', cardinality: 'single', enumValues: null, writableBy: null, evaluationStrategy: null },
    { id: 'pt-title', name: 'Title', description: null, nodeTypeId: 'nt-ticket', edgeTypeId: null, valueType: 'text', cardinality: 'single', enumValues: null, writableBy: null, evaluationStrategy: null },
  ],
  edgeTypes: [
    { id: 'et-owner', outboundName: 'Owner', inboundName: 'Tickets', sourceNodeTypeId: 'nt-ticket', targetNodeTypeId: 'nt-person', required: null, scopes: null, filters: null },
  ],
};

const NODE: KgNode = { id: TICKET, nodeTypeId: 'nt-ticket', properties: { 'pt-status': 'Open', 'pt-title': 'Printer' } };

const envelope = (over: { id?: string; event?: string; changeKind?: string; changedFields?: string[] } = {}) => ({
  ...(over.id !== undefined ? { id: over.id } : {}),
  event: over.event ?? 'record.updated',
  timestamp: '2026-11-02T10:00:01.000Z',
  data: {
    recordId: TICKET,
    nodeTypeId: 'nt-ticket',
    changeKind: over.changeKind ?? 'update',
    changedFields: over.changedFields ?? ['pt-status', 'et-owner'],
    context: { source: { type: 'user_edit' }, occurredAt: '2026-11-02T10:00:00.000Z' },
  },
});

const sources = (node: KgNode | null = NODE) => ({ ontology: async () => ONTOLOGY, node: async () => node });

describe('changeArrivals', () => {
  it('reports an update on the record’s Changes, about the record by its type’s name and id', async () => {
    expect(await changeArrivals(envelope({ id: 'chg-1' }), sources())).toEqual([
      {
        edge: 'Changes',
        key: TICKET,
        identity: 'chg-1',
        landing: {
          recordId: 'chg-1',
          recordType: 'Support Ticket Change',
          fields: {
            Id: 'chg-1',
            Kind: 'updated',
            'Changed Fields': ['Status', 'Owner'],
            'Record Id': TICKET,
            Current: { Status: 'Open', Title: 'Printer' },
          },
        },
        parents: [{ recordId: TICKET, recordType: 'Support Ticket', fields: { Status: 'Open', Title: 'Printer' } }],
        about: { recordType: 'Support Ticket', externalId: TICKET },
        occurredAt: '2026-11-02T10:00:00.000Z',
      },
    ]);
  });

  it('carries no record for a deletion, and reads none', async () => {
    const node = jest.fn();
    const [arrival] = await changeArrivals(envelope({ id: 'chg-2', event: 'record.deleted', changeKind: 'delete', changedFields: [] }), {
      ontology: async () => ONTOLOGY,
      node,
    });
    expect(node).not.toHaveBeenCalled();
    expect(arrival).toMatchObject({ parents: [null], landing: { fields: { Kind: 'deleted', 'Changed Fields': [] } } });
    expect(arrival?.landing.fields).not.toHaveProperty('Current');
  });

  it('names a change the store kept without an id by what it says, the same each time', async () => {
    const [first] = await changeArrivals(envelope(), sources());
    const [again] = await changeArrivals(envelope({ changedFields: ['et-owner', 'pt-status'] }), sources());
    expect(first?.identity).toBe(`${TICKET}:updated:2026-11-02T10:00:00.000Z:et-owner:pt-status`);
    expect(again?.identity).toBe(first?.identity);
  });

  it('runs nothing for a body that is not a change, or a node type the model no longer has', async () => {
    expect(await changeArrivals({ hello: 'world' }, sources())).toEqual([]);
    expect(await changeArrivals({ ...envelope(), data: { ...envelope().data, nodeTypeId: 'nt-gone' } }, sources())).toEqual([]);
  });
});

describe('the graph’s Changes', () => {
  const unused = async (): Promise<never> => {
    throw new Error('not read by a change');
  };
  const store: KgStore = {
    ontology: async () => ONTOLOGY,
    getNode: async (id) => (id === TICKET ? NODE : null),
    nodeTypesOf: unused,
    matchNodes: unused,
    listNodeIds: unused,
    edgesOf: unused,
    resourcesOf: unused,
    createNode: unused,
    updateNode: unused,
    assertEdge: unused,
    updateEdge: unused,
    removeEdge: unused,
    removeNode: unused,
    attachResources: unused,
    registerChangeWebhook: unused,
    removeChangeWebhook: unused,
  };
  const adapter = new KnowledgeGraphAdapter({ store, log: { debug() {}, info() {}, warn() {}, error() {} } });

  it('hangs a listenable Changes off each node type, landing on its change type', async () => {
    const ticket = await adapter.describe('Support Ticket');
    expect(ticket?.references.find((ref) => ref.name === 'Changes')).toMatchObject({
      targetTypeId: 'Support Ticket Change',
      listenable: true,
      readable: false,
      delivery: 'connection',
      identity: 'Id',
      attributes: true,
      carries: ['Support Ticket'],
    });
    expect(await adapter.describe('Support Ticket Change')).toEqual(describeChange(ONTOLOGY, 'Support Ticket'));
    const entries = await adapter.listEntryPoints();
    expect(entries.find((entry) => entry.typeId === 'Support Ticket Change')).toMatchObject({ readable: false, writable: false });
  });

  it('reads a change’s fields off its landing, and walks Record to the record now', async () => {
    const [arrival] = await changeArrivals(envelope({ id: 'chg-3' }), sources());
    const position = makeStablePosition({ adapterType: 'kg', recordType: 'Support Ticket Change', recordId: 'chg-3', data: arrival?.landing.fields ?? {} });
    expect(await adapter.getFieldValue({ position, fieldId: 'Kind' })).toBe('updated');
    expect(await adapter.getFieldValue({ position, fieldId: 'Current' })).toEqual({ Status: 'Open', Title: 'Printer' });
    expect(await adapter.getRelated({ position, fieldId: 'Record', direction: 'outgoing' })).toEqual([
      { position: makeStablePosition({ adapterType: 'kg', recordType: 'Support Ticket', recordId: TICKET }) },
    ]);
  });

  it('waits on a record’s Changes under its id', async () => {
    await expect(adapter.arrivals.awaitKeys({ edge: 'Changes', heads: [{ recordId: TICKET }] })).resolves.toEqual([{ key: TICKET }]);
    await expect(adapter.arrivals.awaitKeys({ edge: 'Tickets', heads: [] })).rejects.toThrow("'Tickets' is not a listenable edge");
  });
});
