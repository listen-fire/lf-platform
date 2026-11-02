// The demo product's own data, and the module its customers' movements reach
// it through: one record type, `Company`, whose fields each customer defines
// (a text field, or a select with its own options). The product reports two
// things a listen may end on: a company a person added, on `Companies`, and a
// person's change to one, on `Changes`. A change carries the company as the
// edit left it (`Current`) and as it was before (`Previous`), as Airtable's
// changes do, so a listen's WHERE compares the two
// (`c.Current.Stage == "Won" AND c.Previous.Stage != "Won"`), each field
// checked against the customer's own.

import type { Arrival } from '@listen-fire/embed';
import type { Adapter, AdapterManifest } from '@listen-fire/engine/public/adapter';
import { BASE_RUNTIME_CAPABILITIES, containerAssociation } from '@listen-fire/engine/public/adapter';
import { makeStablePosition, positionData, type SchemaFieldDescriptor } from '@listen-fire/engine/public/catalog';
import { defineModule, type AdapterModuleMethods, type ModuleContext } from '@listen-fire/module-kit';

export const COMPANY = 'Company';
export const COMPANIES = 'Companies';
export const CHANGE = 'Change';
export const CHANGES = 'Changes';
const CHANGED_FIELDS = 'Changed Fields';

/** A company: its id, and the values of the fields its customer defined. */
export type Company = { id: string } & Record<string, string>;

/** A field a customer defines on `Company`. With `options` it is a select. */
export interface FieldDefinition {
  name: string;
  options?: string[];
}

/** One change to a company: the company as the edit left it and as it was
 *  before, every field by name, and the fields it changed. */
export interface CompanyChange {
  id: string;
  company: string;
  current: Record<string, string>;
  previous: Record<string, string>;
  changed: string[];
}

const NAME_FIELD: FieldDefinition = { name: 'Name' };

/** The product's records and field definitions, by tenant. */
export class CompanyStore {
  private readonly byTenant = new Map<string, Company[]>();
  private readonly fieldsByTenant = new Map<string, FieldDefinition[]>();
  private changes = 0;

  defineFields(tenant: string, fields: FieldDefinition[]): void {
    this.fieldsByTenant.set(tenant, [NAME_FIELD, ...fields]);
  }

  fieldsOf(tenant: string): FieldDefinition[] {
    return this.fieldsByTenant.get(tenant) ?? [NAME_FIELD];
  }

  list(tenant: string): Company[] {
    return this.byTenant.get(tenant) ?? [];
  }

  get(tenant: string, id: string): Company | undefined {
    return this.list(tenant).find((c) => c.id === id);
  }

  add(tenant: string, fields: Record<string, string>): Company {
    const companies = this.byTenant.get(tenant) ?? [];
    const company = { id: `company-${companies.length + 1}`, ...this.defined(tenant, fields) };
    this.byTenant.set(tenant, [...companies, company]);
    return company;
  }

  /** Set the defined fields among `fields`; the change names only those
   *  whose value actually changed. `by` says who made it. */
  update(tenant: string, id: string, fields: Record<string, string>, _by: 'person' | 'automation'): CompanyChange | undefined {
    const company = this.get(tenant, id);
    if (company === undefined) return undefined;
    const { id: _before, ...previous } = company;
    const changed = Object.entries(this.defined(tenant, fields)).filter(([name, value]) => company[name] !== value);
    Object.assign(company, Object.fromEntries(changed));
    const { id: _after, ...current } = company;
    return { id: `change-${++this.changes}`, company: id, current, previous, changed: changed.map(([name]) => name) };
  }

  private defined(tenant: string, fields: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(this.fieldsOf(tenant).flatMap(({ name }) => (typeof fields[name] === 'string' ? [[name, fields[name]]] : [])));
  }
}

/** A company a person added, as it arrives on `Companies`. */
export function companyAdded(company: Company): Arrival {
  return { edge: COMPANIES, identity: company.id, landing: { recordId: company.id, recordType: COMPANY, fields: { ...company } } };
}

/** A person's change, as it arrives on `Changes`: what a listen's WHERE
 *  reads (`Current`, `Previous`, `Changed Fields`), and the company it is
 *  about, which the change's `Company` edge reads again. */
export function companyChanged(change: CompanyChange): Arrival {
  return {
    edge: CHANGES,
    identity: change.id,
    landing: {
      recordId: change.id,
      recordType: CHANGE,
      fields: { Id: change.id, Current: change.current, Previous: change.previous, [CHANGED_FIELDS]: change.changed, company: change.company },
    },
    about: { recordType: COMPANY, externalId: change.company },
  };
}

const MANIFEST: AdapterManifest = {
  adapterType: 'crm',
  displayName: 'CRM',
  description: "The product's own CRM.",
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord'],
  declaredCredentials: ['crm'],
  introspectedSchema: true,
};

/** The id of the company a change is about, off the change's data. */
function changedCompany(data: unknown): string | undefined {
  const id: unknown = data !== null && typeof data === 'object' ? Reflect.get(data, 'company') : undefined;
  return typeof id === 'string' ? id : undefined;
}

const changeField = (fieldId: string, description: string): SchemaFieldDescriptor => ({ fieldId, displayName: fieldId, kind: 'string', writable: false, required: true, description });

/** `Current` and `Previous`: a company, read through by field name. */
const heldCompany = (fieldId: string, description: string): SchemaFieldDescriptor => ({
  fieldId,
  displayName: fieldId,
  kind: 'record',
  record: { typeId: COMPANY },
  writable: false,
  required: true,
  description,
});

function crmAdapter(ctx: ModuleContext, store: CompanyStore): AdapterModuleMethods {
  const tenant = ctx.config.tenant;
  const authorised = async () => {
    if (!(await ctx.credential.fields()).api_key) throw new Error('crm: no API key');
  };
  const record = (company: Company) => ({ adapterType: 'crm', externalId: company.id, recordType: COMPANY, data: { ...company } });
  const related = (company: Company) => ({ position: makeStablePosition({ adapterType: 'crm', recordType: COMPANY, recordId: company.id, data: { ...company } }) });
  const adapter: Adapter = {
    adapterType: 'crm',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [
      { typeId: COMPANY, displayName: COMPANY, collectionName: COMPANIES, writable: true, readable: true, listenable: true, delivery: 'connection' },
      // A change is reported as it happens; the ones that happened cannot be listed.
      { typeId: CHANGE, displayName: CHANGE, collectionName: CHANGES, writable: false, readable: false, listenable: true, delivery: 'connection', identity: 'Id', attributes: true },
    ],
    describe: async (typeId) => {
      if (typeId === COMPANY) {
        return {
          typeId: COMPANY,
          displayName: COMPANY,
          fields: store.fieldsOf(tenant).map(({ name, options }) => ({
            fieldId: name,
            displayName: name,
            kind: options === undefined ? 'string' : 'enum',
            ...(options !== undefined ? { enumValues: options } : {}),
            writable: true,
            required: name === NAME_FIELD.name,
          })),
          references: [],
        };
      }
      if (typeId === CHANGE) {
        return {
          typeId: CHANGE,
          displayName: CHANGE,
          description:
            'A person changed a company: the company as the edit left it (`Current`) and as it was before (`Previous`). ' +
            'Compare them in a listen (`c.Current.Stage == "Won" AND c.Previous.Stage != "Won"`); walk `Company` for the company as it is now.',
          fields: [
            changeField('Id', 'Names the change.'),
            heldCompany('Current', 'The company as the edit left it, every field by name.'),
            heldCompany('Previous', 'The company as it was before the edit, every field by name.'),
            { ...changeField(CHANGED_FIELDS, 'The names of the fields the edit changed.'), cardinality: 'many' },
          ],
          references: [
            { fieldId: COMPANY, name: COMPANY, targetTypeId: COMPANY, cardinality: 'one', direction: 'outgoing', readable: true, writable: false, description: 'The company as it is now.' },
          ],
        };
      }
      return null;
    },
    resolveEntity: async (input) => ({
      candidates: store
        .list(tenant)
        .filter((company) => input.candidates.some((candidate) => candidate.external_id === company.id))
        .map(record),
    }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = positionData(position);
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    getRelated: async ({ position, fieldId, direction }) => {
      if (direction !== 'outgoing') return [];
      if (fieldId === COMPANIES) return store.list(tenant).map(related);
      if (fieldId !== COMPANY) return [];
      const company = store.get(tenant, changedCompany(positionData(position)) ?? '');
      return company === undefined ? [] : [related(company)];
    },
    createRecord: async ({ fields }) => {
      await authorised();
      return record(store.add(tenant, { Name: '', ...Object.fromEntries(Object.entries(fields).filter((f): f is [string, string] => typeof f[1] === 'string')) }));
    },
    // An automation's write. It reports no change: only a person's change does
    // (Product.change), so a movement that updates the company it was fired
    // for cannot fire itself again.
    updateRecord: async (input) => {
      await authorised();
      const fields = Object.fromEntries(Object.entries(input.fields).filter((f): f is [string, string] => typeof f[1] === 'string'));
      if (store.update(tenant, input.externalId, fields, 'automation') === undefined) return { notFound: true };
      const company = store.get(tenant, input.externalId);
      return company === undefined ? { notFound: true } : { ...record(company), association: containerAssociation(input) };
    },
    deleteRecord: async () => {
      throw new Error('crm: a movement may not delete a company');
    },
  };
  return adapter;
}

/** The CRM module over `store`. */
export function crmModule(store: CompanyStore) {
  return defineModule({
    kind: 'adapter',
    name: '@demo/crm',
    manifest: MANIFEST,
    credentials: [{ name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] }],
    create: (ctx) => crmAdapter(ctx, store),
  });
}
