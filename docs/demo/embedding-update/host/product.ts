// The demo product with the engine inside it (`@listen-fire/embed`): each
// customer is a tenant with its own companies and fields, its own API key and
// its own Slack workspace. A person's change to a company raises
// `company.updated`, and every movement of that customer listening for it
// runs here, in this process, before the change is answered.
//
// Loop safety is the product's rule: only a person's change raises an event.
// A movement's own write to a company (the module's updateRecord) raises
// none, so an automation that updates the record it was fired for does not
// fire again.

import type { IncomingMessage } from 'node:http';

import { createAuthoringHandler, type AuthoringHandler } from '@listen-fire/authoring-mcp';
import { createEmbeddedHost, type EmbeddedHost, type EmbeddedRunOutcome } from '@listen-fire/embed';
import { pricedModels, type ModelClient } from '@listen-fire/engine/public/embed';
import { slackModule } from '@listen-fire/slack';

import { authoringStore, authoringTenant } from './authoring';
import { CompanyStore, companyCreated, companyUpdated, crmModule, type Company, type FieldDefinition } from './crm';

/** The names a customer's movement imports its connections by. */
export const CREDENTIAL = 'workspace';
export const SLACK_CREDENTIAL = 'slack_workspace';

/** What a run may consume: a customer's movement is code the product did not write. */
const LIMITS = { maxSteps: 100_000, maxTextBytes: 1024 * 1024, maxCollectionItems: 10_000, maxResultBytes: 4 * 1024 * 1024, costCapMicrodollars: 50_000 };

export interface FiredRun {
  runId: string;
  movement: string;
  outcome: { ok: true; writes: number; spentMicrodollars: number } | { ok: false; error: string };
}

export class Product {
  readonly companies = new CompanyStore();
  private readonly crm = crmModule(this.companies);
  private readonly host: EmbeddedHost;
  private readonly kept = authoringStore(() => new Date());
  private readonly apiKeys = new Map<string, string>();

  constructor(options: { models?: ModelClient } = {}) {
    this.host = createEmbeddedHost({
      modules: [this.crm, slackModule],
      store: this.kept.store,
      limits: LIMITS,
      ...(options.models !== undefined ? { engine: { llm: pricedModels({ client: options.models }) } } : {}),
    });
  }

  async addCustomer(tenant: string, apiKey: string, fields: FieldDefinition[]): Promise<void> {
    this.companies.defineFields(tenant, fields);
    this.apiKeys.set(tenant, apiKey);
    await this.host.connect(tenant, { name: CREDENTIAL, module: this.crm, credential: { api_key: apiKey } });
  }

  async connectSlack(tenant: string, slack: { accessToken: string; baseUrl?: string }): Promise<void> {
    await this.host.connect(tenant, { name: SLACK_CREDENTIAL, module: slackModule, credential: { ...slack } });
  }

  /** A person adds a company. */
  async create(tenant: string, fields: Record<string, string>): Promise<{ company: Company; runs: FiredRun[] }> {
    const company = this.companies.add(tenant, fields);
    return { company, runs: await this.fire(tenant, companyCreated(company)) };
  }

  /** A person changes a company. A change that changes nothing raises nothing. */
  async change(tenant: string, id: string, fields: Record<string, string>): Promise<{ company: Company; runs: FiredRun[] } | undefined> {
    const change = this.companies.update(tenant, id, fields, 'person');
    if (change === undefined) return undefined;
    const runs = Object.keys(change.fields).length > 0 ? await this.fire(tenant, companyUpdated(change)) : [];
    return { company: this.companies.get(tenant, id) ?? change.company, runs };
  }

  private async fire(tenant: string, event: Parameters<EmbeddedHost['dispatch']>[1]['event']): Promise<FiredRun[]> {
    return this.kept.runs.record(await this.host.dispatch(tenant, { adapterType: 'crm', event })).map(firedRun);
  }

  /** The authoring tools over MCP at `/customers/:tenant/mcp`, the
   *  customer's API key as a bearer token (the demo's auth). */
  authoringHandler(): AuthoringHandler {
    const { store, programs, runs } = this.kept;
    return createAuthoringHandler({
      tenant: async (request: IncomingMessage) => {
        const tenant = tenantOfPath(request.url ?? '/');
        const key = this.apiKeys.get(tenant ?? '');
        if (tenant === undefined || key === undefined || request.headers.authorization !== `Bearer ${key}`) {
          return { ok: false, status: 401, message: "send the customer's API key as a bearer token" };
        }
        return { ok: true, tenant: authoringTenant({ tenant, host: this.host, store, programs, runs }) };
      },
      instructions:
        "This is the product's own CRM: a customer's movements read and write its companies, with the fields it defined. " +
        'company.updated fires when a person changes a company; a listen can narrow it with field and becomes.',
    });
  }
}

function firedRun({ runId, program, outcome }: EmbeddedRunOutcome): FiredRun {
  if (!outcome.ok) return { runId, movement: program, outcome };
  return { runId, movement: program, outcome: { ok: true, writes: outcome.writes.length, spentMicrodollars: outcome.spentMicrodollars } };
}

/** `acme` from `/customers/acme/mcp`. */
export function tenantOfPath(url: string): string | undefined {
  const [customers, tenant, mcp, ...rest] = url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  return customers === 'customers' && mcp === 'mcp' && rest.length === 0 ? tenant : undefined;
}
