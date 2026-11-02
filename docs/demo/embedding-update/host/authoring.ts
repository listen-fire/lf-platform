// What the product keeps so an agent can author its customers' movements over
// MCP (`@listen-fire/authoring-mcp`): each customer's saved movements, with
// the plan of each listen, and its runs. Both are the embedded host's own
// store families, kept here so the tools read what the host writes. Taken
// from listen-fire's `examples/embed-saas`.

import type { EmbeddedHost, EmbeddedHostStore, EmbeddedRun, EmbeddedRunOutcome, SavedProgram } from '@listen-fire/embed';
import { memoryEmbeddedHostStore } from '@listen-fire/embed';
import {
  revisionOf,
  type JsonValue,
  type ProgramSaved,
  type ProgramStore,
  type ProgramWrite,
  type RunSource,
  type RunStatus,
  type RunTrace,
  type StoredProgram,
  type TenantHost,
} from '@listen-fire/authoring-mcp';
import { ENGINE_VERSION } from '@listen-fire/engine/public/movement-engine';

interface Kept {
  program: StoredProgram;
  saved: SavedProgram;
}

/** Each customer's saved movements, by id. A write and its revision check
 *  are one synchronous step, so no other write comes between them. */
export class Programs {
  private readonly byTenant = new Map<string, Map<string, Kept>>();
  private next = 1;

  constructor(private readonly now: () => Date) {}

  private of(tenant: string): Map<string, Kept> {
    const known = this.byTenant.get(tenant);
    if (known !== undefined) return known;
    const created = new Map<string, Kept>();
    this.byTenant.set(tenant, created);
    return created;
  }

  list(tenant: string): Kept[] {
    return [...this.of(tenant).values()];
  }

  find(tenant: string, ref: { id: string } | { name: string }): Kept | undefined {
    return 'id' in ref ? this.of(tenant).get(ref.id) : this.list(tenant).find((k) => k.program.name === ref.name);
  }

  /** A write from the authoring tools: already checked (or saved with the user's consent). */
  write(tenant: string, write: ProgramWrite): ProgramSaved {
    const current = write.id !== undefined ? this.of(tenant).get(write.id) : undefined;
    if (write.id !== undefined && current === undefined) return { ok: false, error: `No automation '${write.id}'.` };
    if (current !== undefined && write.expectedRevision !== undefined && revisionOf(current.program.source) !== write.expectedRevision) {
      return { ok: false, conflict: current.program };
    }
    const clash = this.find(tenant, { name: write.name });
    if (clash !== undefined && clash.program.id !== write.id) return { ok: false, error: `An automation is already named '${write.name}'.` };
    const program: StoredProgram = {
      id: current?.program.id ?? `movement-${this.next++}`,
      name: write.name,
      ...(write.description !== undefined ? { description: write.description } : {}),
      source: write.source,
      updatedAt: this.now().toISOString(),
    };
    this.of(tenant).set(program.id, { program, saved: { name: write.name, source: write.source, languageVersion: ENGINE_VERSION, listens: write.listens } });
    return { ok: true, program };
  }

  /** A save through the embedded host (`PUT /customers/:tenant/movements/:name`): by name. */
  put(tenant: string, saved: SavedProgram): void {
    const current = this.find(tenant, { name: saved.name });
    const id = current?.program.id ?? `movement-${this.next++}`;
    const program: StoredProgram = { ...current?.program, id, name: saved.name, source: saved.source, updatedAt: this.now().toISOString() };
    this.of(tenant).set(id, { program, saved });
  }

  delete(tenant: string, id: string): boolean {
    return this.of(tenant).delete(id);
  }
}

/** What each run came to, beside the run the embedded host keeps; where
 *  each stands is its run row in the host's store (`statusOf`). */
export class Runs {
  private readonly runs = new Map<string, EmbeddedRun>();
  private readonly outcomes = new Map<string, EmbeddedRunOutcome['outcome']>();
  private readonly startedAt = new Map<string, string>();
  /** A retry's run, by the tenant and the id its caller gave the request. */
  readonly byRequest = new Map<string, string>();

  constructor(
    private readonly now: () => Date,
    private readonly statusOf: (runId: string) => Promise<string | null>,
  ) {}

  put(run: EmbeddedRun): void {
    if (!this.runs.has(run.runId)) this.startedAt.set(run.runId, this.now().toISOString());
    this.runs.set(run.runId, { ...run });
  }

  get(runId: string): EmbeddedRun | null {
    const run = this.runs.get(runId);
    return run === undefined ? null : { ...run };
  }

  /** Every outcome the embedded host hands back is recorded against its run. */
  record(outcomes: EmbeddedRunOutcome[]): EmbeddedRunOutcome[] {
    for (const { runId, outcome } of outcomes) this.outcomes.set(runId, outcome);
    return outcomes;
  }

  /** A tenant's runs of one program, newest first. */
  of(tenant: string, program: string): EmbeddedRun[] {
    return [...this.runs.values()].filter((r) => r.tenant === tenant && r.program === program).reverse();
  }

  async trace(run: EmbeddedRun): Promise<RunTrace> {
    const outcome = this.outcomes.get(run.runId);
    const status = runStatusOf(await this.statusOf(run.runId));
    const writes = outcome?.ok === true ? outcome.writes.map(toJson) : [];
    return {
      runId: run.runId,
      status,
      startedAt: this.startedAt.get(run.runId) ?? run.input.firedAt ?? '',
      ...(outcome?.ok === true ? { recordCount: outcome.writes.length } : {}),
      ...(outcome?.ok === false ? { failureReason: outcome.error } : {}),
      event: toJson(run.input.event),
      writes,
      decisions: [],
      errors: outcome?.ok === false ? [outcome.error] : [],
    };
  }
}

/** A run row's status as the authoring tools say it: none yet is running. */
function runStatusOf(status: string | null): RunStatus {
  switch (status) {
    case null:
    case 'running':
      return 'running';
    case 'parked':
      return 'parked';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      throw new Error(`a run row with status ${JSON.stringify(status)}, which the embedded host never writes`);
  }
}

function toJson(value: unknown): JsonValue {
  const round: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return round;
}

/** The embedded host's store, with its programs and runs kept where the
 *  authoring tools read them. */
export function authoringStore(now: () => Date) {
  const programs = new Programs(now);
  const base = memoryEmbeddedHostStore({ now: () => now().getTime() });
  const runs = new Runs(now, (runId) => base.runHost.runStatus({ runId }));
  const store: EmbeddedHostStore = {
    ...base,
    programs: {
      put: async (tenant, saved) => programs.put(tenant, saved),
      list: async (tenant) => programs.list(tenant).map((k) => k.saved),
    },
    runs: { put: async (run) => runs.put(run), get: async (runId) => runs.get(runId) },
  };
  return { store, programs, runs };
}

/** One customer's host for the authoring tools. */
export function authoringTenant(input: {
  tenant: string;
  host: EmbeddedHost;
  store: EmbeddedHostStore;
  programs: Programs;
  runs: Runs;
}): TenantHost {
  const { tenant, host, store, programs, runs } = input;
  const requestKey = (requestId: string) => `${encodeURIComponent(tenant)}/${requestId}`;
  const view = async (run: EmbeddedRun) => {
    const { event: _event, writes: _writes, decisions: _decisions, errors: _errors, ...rest } = await runs.trace(run);
    return rest;
  };
  const programStore: ProgramStore = {
    list: async () => programs.list(tenant).map((k) => k.program),
    get: async (ref) => programs.find(tenant, ref)?.program ?? null,
    save: async (write) => programs.write(tenant, write),
    delete: async (id) => programs.delete(tenant, id),
  };
  const runSource: RunSource = {
    async start({ program, text, files, requestId }) {
      const replayed = requestId !== undefined ? runs.byRequest.get(requestKey(requestId)) : undefined;
      const known = replayed !== undefined ? runs.get(replayed) : null;
      if (known !== null) return { ok: true, runId: known.runId, status: (await view(known)).status };
      if (files !== undefined && files.length > 0) return { ok: false, error: 'this product keeps no files: run it on text' };
      const [first] = runs.record(await host.run(tenant, { program: program.name, ...(text !== undefined ? { text } : {}) }));
      if (first === undefined) return { ok: false, error: `'${program.name}' does not listen to \`manual-[:Invocations]->\`, so it cannot be run on demand` };
      if (requestId !== undefined) runs.byRequest.set(requestKey(requestId), first.runId);
      const run = runs.get(first.runId);
      return { ok: true, runId: first.runId, status: run === null ? 'running' : (await view(run)).status };
    },
    status: async (runId) => {
      const run = runs.get(runId);
      return run === null || run.tenant !== tenant ? null : view(run);
    },
    list: async (program, { limit }) => Promise.all(runs.of(tenant, program.name).slice(0, limit).map(view)),
    trace: async (runId) => {
      const run = runs.get(runId);
      return run === null || run.tenant !== tenant ? null : runs.trace(run);
    },
  };
  return {
    catalog: async ({ fresh }) => {
      // A describe asks for the schema as it is now: a field the customer just added shows.
      if (fresh) host.schemaChanged(tenant);
      const connections = await store.connections.list(tenant);
      return { snapshot: await host.catalog(tenant), connections: connections.map(({ name, adapterType }) => ({ name, system: adapterType })) };
    },
    programs: programStore,
    runs: runSource,
  };
}
