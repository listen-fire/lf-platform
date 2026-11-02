// The knowledge graph's natural-name read seam, engine side.
//
// surfaceReadAdapter — the natural-name→internal-id read translation, driven
// by the adapter's OWN introspection-derived resolver (uniform across
// adapters; the KG is not special): getFieldValue translates property names
// per type, getRelated translates edge names to EdgeTypeIds and stamps landed
// positions with the hop target's natural type.
//
// (A 0.12 graph listen seeded the changed record itself; from 0.13 a listen
// on a record's `Changes` lands the change, modules/kg's subject.)

// ── Jest module workarounds (mirrors run.unit.test.ts) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??=
  'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.SCRAPER_API_KEY ??= 'unit-test-unused';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => null;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../context', () => ({
  unsafeCurrentContext: () => undefined,
  currentContext: () => ({
    user: undefined,
    runAsync: async <T>(fn: () => Promise<T>) => fn(),
  }),
}));

// The graph's manifest without its connection requirement, so these runs
// construct `kg()` bare (the platform's real one needs a credential).
jest.mock('@listen-fire/kg/manifest', () => ({
  KG_ADAPTER_TYPE: 'kg',
  kgManifest: () => ({
    adapterType: 'kg',
    displayName: 'Knowledge Graph',
    supportedTriggers: ['mutation'],
    methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated'],
    triggerKinds: ['KG_MUTATION'],
    subscribableEvents: ['record.created', 'record.updated', 'record.deleted'],
    listenConfig: [
      { key: 'type', required: true, narrows: { collection: 'Node Type', matchField: 'Id' } },
      { key: 'fields', format: 'fields' },
    ],
  }),
}));

jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => '{}'),
  anthropicChatDetailed: jest.fn(async () => ({
    text: '{}',
    stopReason: 'end_turn',
    truncated: false,
  })),
  MAX_CHAT_CONTINUATIONS: 5,
}));
jest.mock('../../translation_graph/adapters/acting_user/resolve', () => ({
  resolveActingUser: jest.fn(async () => null),
}));
import type { InstanceSchema } from 'movement-lang';
import { runMovement } from '@listen-fire/legacy-engine/dispatch';
import { MovementEngineError } from '@listen-fire/legacy-engine/services/movement_engine/expression';
import { surfaceReadAdapter } from '@listen-fire/legacy-engine/services/movement_engine/kg';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import type {
  Adapter,
  RuntimeCapabilities,
} from 'movement-engine/public/adapter';
import { containerAssociation } from 'movement-engine/public/adapter';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import {
  makeStablePosition,
  positionData,
  positionRecordId,
} from 'engine-contracts/catalog';
import { tenantIdOf } from 'engine-contracts';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import { credentialIdsFor, makeTestHost } from 'movement-engine/public/testing';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-000000000010');
const COMPANY_NODE_ID = '00000000-0000-0000-0000-00000000c001' as NodeId;

function permissiveCaps(): RuntimeCapabilities {
  return {
    traversal: { incoming: true, edgeProperties: true },
    resources: true,
  };
}

interface RecordedWrite {
  recordType: string;
  externalId?: string;
  fields: Record<string, unknown>;
}

function makeTargetFake(adapterType: string): { adapter: Adapter; creates: RecordedWrite[] } {
  const creates: RecordedWrite[] = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push({ recordType: input.recordType, fields: input.fields });
      return { adapterType, externalId: `ext-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

/** A fake KG SOURCE: per-node property bags + per-(node, edge) neighbours. */
function makeKgFake(input: {
  records: Record<string, Record<string, unknown>>;
  edges?: Record<string, Record<string, Array<{ id: string; data?: Record<string, unknown> }>>>;
}): Adapter {
  return {
    adapterType: 'kg',
    supportedTriggers: ['mutation'] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const id = positionRecordId(position);
      return id !== undefined ? (input.records[id]?.[fieldId] ?? null) : null;
    },
    async getRelated({ position, fieldId }) {
      const id = positionRecordId(position);
      const neighbours = id !== undefined ? (input.edges?.[id]?.[fieldId] ?? []) : [];
      return neighbours.map((n) => ({
        position: makeStablePosition({
          adapterType: 'kg',
          recordType: null,
          recordId: n.id,
          ...(n.data !== undefined ? { data: n.data } : {}),
        }),
      }));
    },
    async createRecord() {
      throw new Error('test: the kg fake is a source — nothing writes to it here');
    },
    async updateRecord() {
      throw new Error('test: the kg fake is a source — nothing writes to it here');
    },
    async deleteRecord() {
      return {};
    },
  };
}

const kgSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', domains: { kind: 'list', of: 'text' } },
      edges: { rounds: { target: 'funding_round' } },
    },
    funding_round: { properties: { stage: 'text' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};

const catalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { kg: kgSchema },
});

describe('surfaceReadAdapter — natural-name read seam (KG)', () => {
  // The wrapper carries NO name↔id translation (Decision #3 — the adapter
  // does that internally). Its job is to STAMP each position's `recordType`
  // with the hop target's NATURAL type (from the instance schema) and PRESERVE
  // inline `data`, so the adapter's own `getFieldValue` can resolve the
  // (verbatim) natural field name against the right type. It passes field /
  // edge names through unchanged.

  function recordingInner(): {
    adapter: Adapter;
    fieldReads: Array<{ fieldId: string; recordType: string | null; recordId?: string }>;
    relatedReads: Array<{ fieldId: string; recordType: string | null }>;
  } {
    const fieldReads: Array<{ fieldId: string; recordType: string | null; recordId?: string }> = [];
    const relatedReads: Array<{ fieldId: string; recordType: string | null }> = [];
    const adapter: Adapter = {
      adapterType: 'kg',
      supportedTriggers: [] as never[],
      runtimeCapabilities: () => permissiveCaps(),
      async listEntryPoints() {
        return [];
      },
      async describe() {
        return null;
      },
      async resolveEntity() {
        return { candidates: [] };
      },
      async getFieldValue({ position, fieldId }) {
        fieldReads.push({
          fieldId,
          recordType: position.recordType,
          ...(positionRecordId(position) !== undefined
            ? { recordId: positionRecordId(position) }
            : {}),
        });
        return 'value';
      },
      async getRelated({ position, fieldId }) {
        relatedReads.push({ fieldId, recordType: position.recordType });
        return [
          {
            position: makeStablePosition({
              adapterType: 'kg',
              recordType: null,
              recordId: 'round-1',
            }),
          },
        ];
      },
      async createRecord() {
        throw new Error('unused');
      },
      async updateRecord() {
        throw new Error('unused');
      },
      async deleteRecord() {
        return {};
      },
    };
    return { adapter, fieldReads, relatedReads };
  }

  const kgSchemaForWrapper: InstanceSchema = {
    positions: {
      company: { properties: { name: 'text' }, edges: { rounds: { target: 'funding_round' } } },
      funding_round: { properties: { stage: 'text' }, edges: {} },
    },
    collections: {},
    writableRoots: {},
  };

  const companyPosition = makeStablePosition({
    adapterType: 'kg',
    recordType: 'company',
    recordId: COMPANY_NODE_ID,
  });

  it('passes the natural field name through verbatim, with the position natural type', async () => {
    const inner = recordingInner();
    const wrapped = surfaceReadAdapter({
      inner: inner.adapter,
      schema: kgSchemaForWrapper,
    });
    await wrapped.getFieldValue({ position: companyPosition, fieldId: 'name' });
    // The wrapper does NOT translate — the adapter receives the natural field
    // name and the natural type on the position (it resolves them itself).
    expect(inner.fieldReads).toEqual([
      { fieldId: 'name', recordType: 'company', recordId: COMPANY_NODE_ID },
    ]);
  });

  it('passes the natural edge name through and stamps the landed natural type', async () => {
    const inner = recordingInner();
    const wrapped = surfaceReadAdapter({
      inner: inner.adapter,
      schema: kgSchemaForWrapper,
    });
    const related = await wrapped.getRelated({
      position: companyPosition,
      fieldId: 'rounds',
      direction: 'outgoing',
    });
    // Edge name crosses verbatim; the FROM position carries its natural type.
    expect(inner.relatedReads).toEqual([{ fieldId: 'rounds', recordType: 'company' }]);
    expect(related).toHaveLength(1);
    // The landed record is stamped with the schema edge's target natural type.
    expect(related[0].position).toMatchObject({ recordType: 'funding_round' });

    // A deeper read off the landed position carries the stamped natural type,
    // so the adapter resolves ITS field against the right type.
    await wrapped.getFieldValue({ position: related[0].position, fieldId: 'stage' });
    expect(inner.fieldReads).toEqual([
      { fieldId: 'stage', recordType: 'funding_round', recordId: 'round-1' },
    ]);
  });

  it('roots a typeless event position at the parameter natural type (startSurfaceType)', async () => {
    const inner = recordingInner();
    const wrapped = surfaceReadAdapter({
      inner: inner.adapter,
      schema: kgSchemaForWrapper,
      startSurfaceType: 'company',
    });
    const typeless = makeStablePosition({
      adapterType: 'kg',
      recordType: null,
      recordId: COMPANY_NODE_ID,
    });
    await wrapped.getFieldValue({ position: typeless, fieldId: 'name' });
    // The typeless root is stamped with the parameter's declared natural type
    // so the adapter knows which type to resolve `name` against.
    expect(inner.fieldReads).toEqual([
      { fieldId: 'name', recordType: 'company', recordId: COMPANY_NODE_ID },
    ]);
  });
});
