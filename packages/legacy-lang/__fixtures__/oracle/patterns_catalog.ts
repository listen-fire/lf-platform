// The engine patterns oracle's world (listen-fire's crates/movement-engine/tests/oracle/
// patterns.json, which the language keeps), as the platform's tests read
// it: the catalog its programs check and run against and the prelude every
// file starts with. A copy of what the oracle generator defined, so no
// platform file imports the language's generator scripts.

import { mockCatalogSnapshot, type InstanceSchema, type PluginSpec } from 'movement-lang';

const emailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { subject: 'text', text: 'text', user: 'text', amount: 'number', deck: 'file', meta: 'json', missing: 'text', sent: 'datetime' },
      edges: { files: { target: 'attachment', sequenced: 'document' } },
    },
    attachment: { properties: { filename: 'text', contentType: 'text', data: 'file' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
};

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', stage: 'text', domain: 'text', summary: 'text', employees: 'number' },
      edges: { notes: { target: 'note', writable: true }, deals: { target: 'deal' }, people: { target: 'person' } },
    },
    note: { properties: { body: 'text', title: 'text', payload: 'json' }, edges: {} },
    deal: { properties: { title: 'text', amount: 'number' }, edges: { people: { target: 'person' } } },
    person: { properties: { name: 'text', email: 'text' }, edges: { company: { target: 'company', writable: true } } },
    bag: { properties: {}, edges: {}, openProperties: true },
  },
  collections: {
    companies: { target: 'company' },
    notes: { target: 'note' },
    deals: { target: 'deal' },
    people: { target: 'person' },
    bags: { target: 'bag' },
  },
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', domain: 'text', summary: 'text', employees: 'number' },
      resultShape: { externalId: 'text', name: 'text' },
      fuzzyResolution: true,
    },
    note: { fields: { body: 'text', title: 'text', payload: 'json' }, resultShape: { externalId: 'text' } },
    deal: { fields: { title: 'text', amount: 'number' }, resultShape: { externalId: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const PLUGINS: Record<string, PluginSpec> = {
  // The catalog's registered fetch_url, as the oracle was generated against.
  fetch_url: {
    args: ['url', 'email', 'password'],
    priced: true,
    argTypes: { url: 'text', email: 'text', password: 'text' },
    requiredArgs: ['url'],
    effects: { reads: ['the web'] },
    output: { kind: 'value', type: { kind: 'maybeAbsent', of: 'text' } },
    description: 'Fetch one named URL and hand back its content. Emits a single ephemeral Url record.',
    package: '@lf/web',
    name: 'fetch_url',
  },
  find_files: { args: ['q'], priced: false, effects: { ai: true }, output: { kind: 'records', fields: { url: 'text', name: 'text' } } },
  echo: { args: ['q'], priced: false, effects: { ai: true }, output: { kind: 'value', type: 'text' } },
  summarise: { args: ['data'], priced: false, argTypes: { data: 'json' }, requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
};

export const PATTERNS_CATALOG = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
  },
  credentials: { inbox_cred: { adapters: ['email'] }, crm_cred: { adapters: ['attio'] } },
  plugins: PLUGINS,
});

/** What every program's file starts with, in its version 5 spelling. */
export const PATTERNS_PRELUDE = [
  'import { email, attio } from adapters',
  'import { inbox_cred, crm_cred } from credentials',
  'inbox = connect email using inbox_cred',
  'crm = connect attio using crm_cred',
  '',
].join('\n');

export function sourceOf(program: { body?: string; file?: string }): string {
  if (program.file !== undefined) return PATTERNS_PRELUDE + program.file;
  return `${PATTERNS_PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${program.body ?? ''}\n}`;
}
