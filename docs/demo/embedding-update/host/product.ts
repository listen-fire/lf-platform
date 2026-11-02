// The demo product with the engine inside it (`@listen-fire/embed`): each
// customer is a tenant with its own companies and fields, its own API key and
// its own Slack workspace. A person adding or changing a company is reported
// to the embedded host as an arrival on the CRM, and every movement of that
// customer whose listen takes it runs here, in this process, before the
// person's request is answered.
//
// Loop safety is the product's rule: only a person's change is reported. A
// movement's own write to a company (the module's updateRecord) reports
// none, so an automation that updates the company it was fired for does not
// fire again.

import type { IncomingMessage } from 'node:http';

import { createAuthoringHandler, type AuthoringHandler } from '@listen-fire/authoring-mcp';
import { createEmbeddedHost, type Arrival, type ArrivalNotJudged, type EmbeddedHost, type EmbeddedRunOutcome } from '@listen-fire/embed';
import { pricedModels, type ModelClient } from '@listen-fire/engine/public/embed';
import { slackModule } from '@listen-fire/slack';

import { authoringStore, authoringTenant } from './authoring';
import { CompanyStore, companyAdded, companyChanged, crmModule, type Company, type FieldDefinition } from './crm';

/** The names a customer's movement connects its CRM and its Slack by. */
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
  /** The saved movements and runs, where the authoring tools read them. */
  readonly kept = authoringStore(() => new Date());
  /** Each arrival a customer's listen could not judge: it ran nothing. */
  readonly notJudged: ArrivalNotJudged[] = [];
  private readonly apiKeys = new Map<string, string>();

  constructor(options: { models?: ModelClient } = {}) {
    this.host = createEmbeddedHost({
      modules: [this.crm, { module: slackModule, package: '@lf/slack' }],
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
    return { company, runs: await this.fire(tenant, companyAdded(company)) };
  }

  /** A person changes a company. A change that changes nothing reports nothing. */
  async change(tenant: string, id: string, fields: Record<string, string>): Promise<{ company: Company; runs: FiredRun[] } | undefined> {
    const change = this.companies.update(tenant, id, fields, 'person');
    if (change === undefined) return undefined;
    const runs = change.changed.length > 0 ? await this.fire(tenant, companyChanged(change)) : [];
    const company = this.companies.get(tenant, id);
    return company === undefined ? undefined : { company: { ...company }, runs };
  }

  /** Something arrived in a customer's CRM: run each of its movements whose listen takes it. */
  async fire(tenant: string, arrival: Arrival): Promise<FiredRun[]> {
    const { runs, notJudged } = await this.host.dispatch(tenant, { adapterType: 'crm', arrivals: [arrival] });
    this.notJudged.push(...notJudged);
    return this.kept.runs.record(runs).map(firedRun);
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
        "A person's change to a company arrives on the CRM's Changes, with the company before and after it (Previous, Current).",
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
