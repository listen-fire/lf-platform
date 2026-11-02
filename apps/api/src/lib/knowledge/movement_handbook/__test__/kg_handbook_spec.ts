// The knowledge graph's surface the handbook's kg examples are checked against,
// built from this platform's graph module over a representative ontology.
//
// listen-fire's handbook carries the same thing as a fixture
// (packages/handbook/__test__/kg_ontology.fixture.json), because the graph is
// this platform's module and the handbook cannot import it. That fixture still
// predates the graph's per-type `Changes` (it carries 0.12's `Record Change`),
// so the kg section's probes are held here to what the module declares now.
// Once the fixture is regenerated from `kgHandbookSpec()`, the two are equal
// and the `it.failing` beside the claims turns red: then use the fixture.

import type { CatalogSnapshot } from 'movement-lang';
import type { SchemaTypeDescriptor } from 'movement-engine/public/catalog';
import type { KgStore, WireOntology } from '@listen-fire/kg';

import { mockCatalogSnapshot } from 'movement-lang';
import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';
import { HANDBOOK_CATALOG, HANDBOOK_KG_SPEC } from '@listen-fire/handbook/testing';
import { KnowledgeGraphAdapter } from '@listen-fire/kg';

const property = (id: string, name: string, nodeTypeId: string, valueType: string, cardinality = 'single') => ({
  id,
  name,
  description: null,
  nodeTypeId,
  edgeTypeId: null,
  valueType,
  cardinality,
  enumValues: null,
  writableBy: null,
  evaluationStrategy: null,
});

const nodeType = (id: string, name: string, uniqueness: WireOntology['nodeTypes'][number]['uniquenessConstraints'] = { any: [] }) => ({
  id,
  name,
  description: null,
  category: null,
  displayNameTemplate: null,
  displayNameExpression: null,
  uniquenessConstraints: uniqueness,
});

const edgeType = (id: string, outboundName: string, inboundName: string, sourceNodeTypeId: string, targetNodeTypeId: string) => ({
  id,
  outboundName,
  inboundName,
  sourceNodeTypeId,
  targetNodeTypeId,
  required: null,
  scopes: null,
  filters: null,
});

/** `Company`, `Person` and `Support Ticket`: set dressing, as the handbook's
 *  credential aliases are. A multi-word type proves a name with a space rides
 *  the same spellings a bare one does. */
const ONTOLOGY: WireOntology = {
  nodeTypes: [
    nodeType('nt-company', 'Company', { any: [{ all: [{ field: 'pt-company-name', fuzzy: true }] }] }),
    nodeType('nt-person', 'Person'),
    nodeType('nt-ticket', 'Support Ticket'),
  ],
  propertyTypes: [
    property('pt-company-name', 'Name', 'nt-company', 'text'),
    property('pt-company-domains', 'Domains', 'nt-company', 'text', 'multi'),
    property('pt-company-stage', 'Stage', 'nt-company', 'text'),
    property('pt-person-name', 'Name', 'nt-person', 'text'),
    property('pt-person-email', 'Email', 'nt-person', 'text'),
    property('pt-ticket-status', 'Status', 'nt-ticket', 'text'),
    property('pt-ticket-priority', 'Priority', 'nt-ticket', 'number'),
  ],
  edgeTypes: [
    edgeType('et-team', 'Team', 'Companies', 'nt-company', 'nt-person'),
    edgeType('et-tickets', 'Support Tickets', 'Company', 'nt-company', 'nt-ticket'),
    edgeType('et-reporter', 'Reporter', 'Reported Tickets', 'nt-ticket', 'nt-person'),
  ],
};

/** A store that knows the ontology and holds no records: describing needs
 *  nothing more. */
const ontologyOnly = new Proxy({} as KgStore, {
  get: (_target, method) =>
    method === 'ontology'
      ? async () => ONTOLOGY
      : () => {
          throw new Error(`the handbook's graph holds no records (${String(method)})`);
        },
});

/** The graph's surface over the representative ontology, as the catalog
 *  projects it: each type described, and each change type its `Changes`
 *  lands on reached by traversal. */
export async function kgHandbookSpec(): Promise<typeof HANDBOOK_KG_SPEC> {
  const adapter = new KnowledgeGraphAdapter({ store: ontologyOnly, log: { debug() {}, info() {}, warn() {}, error() {} } });
  const entries = await adapter.listEntryPoints();
  const descriptors = new Map<string, SchemaTypeDescriptor>();
  for (const entry of entries) {
    const descriptor = await adapter.describe(entry.typeId);
    if (descriptor !== null) descriptors.set(entry.typeId, descriptor);
  }
  const reachedNames = [...descriptors.values()].flatMap((d) => d.references.filter((r) => r.listenable === true).map((r) => r.targetTypeId));
  const reached = [];
  for (const name of new Set(reachedNames)) {
    const descriptor = await adapter.describe(name);
    if (descriptor === null) continue;
    descriptors.set(name, descriptor);
    reached.push({ typeId: name, displayName: descriptor.displayName, readable: true, writable: false });
  }
  const projection = instanceSchemaFromDescriptors({ adapterType: 'kg', entries, reached, descriptors, supportsInPlaceUpdate: true });
  return { ...HANDBOOK_KG_SPEC, schema: projection.schema };
}

/** The handbook's catalog with the graph's surface as this platform's module
 *  declares it. */
export async function handbookCatalogWithPlatformKg(): Promise<CatalogSnapshot> {
  const { adapters } = mockCatalogSnapshot({ adapters: { kg: await kgHandbookSpec() } });
  return { ...HANDBOOK_CATALOG, adapters: { ...HANDBOOK_CATALOG.adapters, ...adapters } };
}
