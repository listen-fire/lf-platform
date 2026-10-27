// The demo product's own data, and the module its customers' movements reach
// it through: one record type, `Company`, whose fields each customer defines
// (a text field, or a select with its own options), and two events a listen
// may choose, `company.created` and `company.updated`. An update event names
// the fields a person changed, their new values and their previous ones, so a
// listen can narrow to one field and the value it becomes
// (`field: "Stage", becomes: "Won"`), gated by the embedded host.

import type { Adapter, AdapterManifest, DiscriminableEvent } from '@listen-fire/engine/public/adapter';
import { BASE_RUNTIME_CAPABILITIES, containerAssociation } from '@listen-fire/engine/public/adapter';
import { makeStablePosition } from '@listen-fire/engine/public/catalog';
import { defineModule, type AdapterModuleMethods, type ModuleContext } from '@listen-fire/module-kit';

export const COMPANY = 'Company';
export const COMPANY_CREATED = 'company.created';
export const COMPANY_UPDATED = 'company.updated';

/** A company: its id, and the values of the fields its customer defined. */
export type Company = { id: string } & Record<string, string>;

/** A field a customer defines on `Company`. With `options` it is a select. */
export interface FieldDefinition {
  name: string;
  options?: string[];
}

/** One change to a company: the record after it, and the fields it changed,
 *  with their new and previous values. */
export interface CompanyChange {
  company: Company;
  fields: Record<string, string>;
  previous: Record<string, string>;
}

const NAME_FIELD: FieldDefinition = { name: 'Name' };

/** The product's records and field definitions, by tenant. */
export class CompanyStore {
  private readonly byTenant = new Map<string, Company[]>();
  private readonly fieldsByTenant = new Map<string, FieldDefinition[]>();

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
    const changed = Object.entries(this.defined(tenant, fields)).filter(([name, value]) => company[name] !== value);
    const previous = Object.fromEntries(changed.flatMap(([name]) => (company[name] !== undefined ? [[name, company[name]]] : [])));
    Object.assign(company, Object.fromEntries(changed));
    return { company: { ...company }, fields: Object.fromEntries(changed), previous };
  }

  private defined(tenant: string, fields: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(this.fieldsOf(tenant).flatMap(({ name }) => (typeof fields[name] === 'string' ? [[name, fields[name]]] : [])));
  }
}

/** `company.created`, as a listen reads it: the new record. */
export function companyCreated(company: Company): DiscriminableEvent {
  return { payload: company, externalId: company.id, tag: COMPANY_CREATED, eventType: COMPANY_CREATED, changeType: 'create', recordType: COMPANY };
}

/** `company.updated`: the record as it is now, plus the changed fields' new
 *  values (`fields`) and previous ones (`previous`), which the host's
 *  `field`/`becomes` gate reads. */
export function companyUpdated({ company, fields, previous }: CompanyChange): DiscriminableEvent {
  return {
    payload: { ...company, fields, previous },
    externalId: company.id,
    tag: COMPANY_UPDATED,
    eventType: COMPANY_UPDATED,
    changeType: 'update',
    recordType: COMPANY,
    changedFields: Object.keys(fields),
  };
}

const MANIFEST: AdapterManifest = {
  adapterType: 'crm',
  displayName: 'CRM',
  description: "The product's own CRM.",
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'listEventTypes'],
  subscribableEvents: [COMPANY_CREATED, COMPANY_UPDATED],
  // `field: "Stage"` fires only on a change to that field; `becomes: "Won"`
  // (with `field`) only when the change made it that value. The checker holds
  // both to the customer's own fields and options.
  listenConfig: [
    { key: 'field', format: 'field' },
    { key: 'becomes', format: 'field-value' },
  ],
  declaredCredentials: ['crm'],
  introspectedSchema: true,
};

function crmAdapter(ctx: ModuleContext, store: CompanyStore): AdapterModuleMethods {
  const tenant = ctx.config.tenant;
  const authorised = async () => {
    if (!(await ctx.credential.fields()).api_key) throw new Error('crm: no API key');
  };
  const record = (company: Company) => ({ adapterType: 'crm', externalId: company.id, recordType: COMPANY, data: { ...company } });
  const adapter: Adapter = {
    adapterType: 'crm',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    // A listen delivers the company itself (`fires`): what lets the checker
    // hold a listen's `field` and `becomes` to the customer's own fields.
    listEntryPoints: async () => [{ typeId: COMPANY, displayName: COMPANY, writable: true, readable: true, fires: true }],
    describe: async (typeId) =>
      typeId === COMPANY
        ? {
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
          }
        : null,
    resolveEntity: async (input) => ({
      candidates: store
        .list(tenant)
        .filter((company) => input.candidates.some((candidate) => candidate.external_id === company.id))
        .map(record),
    }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.kind === 'stable' ? position.identity.data : undefined;
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    getRelated: async ({ fieldId, direction }) =>
      direction === 'outgoing' && fieldId === COMPANY
        ? store.list(tenant).map((company) => ({ position: makeStablePosition({ adapterType: 'crm', recordType: COMPANY, recordId: company.id, data: { ...company } }) }))
        : [],
    createRecord: async ({ fields }) => {
      await authorised();
      return record(store.add(tenant, { Name: '', ...Object.fromEntries(Object.entries(fields).filter((f): f is [string, string] => typeof f[1] === 'string')) }));
    },
    // An automation's write. It raises no event: only a person's change does
    // (Product.change), so a movement that updates the record it was fired
    // for cannot fire itself again.
    updateRecord: async (input) => {
      await authorised();
      const fields = Object.fromEntries(Object.entries(input.fields).filter((f): f is [string, string] => typeof f[1] === 'string'));
      const change = store.update(tenant, input.externalId, fields, 'automation');
      if (change === undefined) return { notFound: true };
      return { ...record(change.company), association: containerAssociation(input) };
    },
    deleteRecord: async () => {
      throw new Error('crm: a movement may not delete a company');
    },
    listEventTypes: async () => [
      { tag: COMPANY_CREATED, positionType: COMPANY },
      { tag: COMPANY_UPDATED, positionType: COMPANY },
    ],
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
