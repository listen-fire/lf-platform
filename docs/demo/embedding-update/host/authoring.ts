// What the product keeps so an agent can author its customers' movements over
// MCP (`@listen-fire/authoring-mcp`): each customer's saved movements, and
// their runs. Both are the embedded host's own store families, kept here so
// the agent's tools read what the host writes.

import type { EmbeddedHost, EmbeddedHostStore, EmbeddedRun, EmbeddedRunOutcome, SavedProgram } from '@listen-fire/embed';
import { memoryEmbeddedHostStore } from '@listen-fire/embed';
import { revisionOf, type JsonValue, type ProgramSaved, type ProgramWrite, type RunTrace, type StoredProgram, type TenantHost } from '@listen-fire/authoring-mcp';
import { ENGINE_VERSION } from '@listen-fire/engine/public/movement-engine';

interface Kept {
  program: StoredProgram;
  saved: SavedProgram;
}

/** Each customer's saved movements, by id. */
class Programs {
  private readonly byTenant = new Map<string, Map<string, Kept>>();
  private next = 1;

  constructor(private readonly now: () => Date) {}

  private of(tenant: string): Map<string, Kept> {
    const known = this.byTenant.get(tenant) ?? new Map<string, Kept>();
    this.byTenant.set(tenant, known);
    return known;
  }

  list(tenant: string): Kept[] {
    return [...this.of(tenant).values()];
  }

  find(tenant: string, ref: { id: string } | { name: string }): Kept | undefined {
    return 'id' in ref ? this.of(tenant).get(ref.id) : this.list(tenant).find((k) => k.program.name === ref.name);
  }

  /** A write from the authoring tools, already checked. The revision check
   *  and the write are one synchronous step. */
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
    this.of(tenant).set(program.id, { program, saved: { name: write.name, source: write.source, languageVersion: ENGINE_VERSION, listeners: write.listeners } });
    return { ok: true, program };
  }
}

/** Each run, and what it came to. */
class Runs {
  private readonly runs = new Map<string, EmbeddedRun>();
  private readonly outcomes = new Map<string, EmbeddedRunOutcome['outcome']>();
  private readonly startedAt = new Map<string, string>();

  constructor(private readonly now: () => Date) {}

  put(run: EmbeddedRun): void {
    if (!this.runs.has(run.runId)) this.startedAt.set(run.runId, this.now().toISOString());
    this.runs.set(run.runId, { ...run });
  }

  /** The host reads a run back by its id alone. */
  byId(runId: string): EmbeddedRun | null {
    const run = this.runs.get(runId);
    return run === undefined ? null : { ...run };
  }

  /** The tools read only their own customer's runs. */
  get(tenant: string, runId: string): EmbeddedRun | null {
    const run = this.byId(runId);
    return run?.tenant === tenant ? run : null;
  }

  record(outcomes: EmbeddedRunOutcome[]): EmbeddedRunOutcome[] {
    for (const { runId, outcome } of outcomes) this.outcomes.set(runId, outcome);
    return outcomes;
  }

  /** A customer's runs of one movement, newest first. */
  of(tenant: string, program: string): EmbeddedRun[] {
    return [...this.runs.values()].filter((r) => r.tenant === tenant && r.program === program).reverse();
  }

  trace(run: EmbeddedRun): RunTrace {
    const outcome = this.outcomes.get(run.runId);
    return {
      runId: run.runId,
      status: run.status === 'completed' ? 'success' : run.status,
      startedAt: this.startedAt.get(run.runId) ?? run.input.firedAt ?? '',
      ...(outcome?.ok === true ? { recordCount: outcome.writes.length } : {}),
      ...(outcome?.ok === false ? { failureReason: outcome.error } : {}),
      event: toJson(run.input.event),
      writes: outcome?.ok === true ? outcome.writes.map(toJson) : [],
      decisions: [],
      errors: outcome?.ok === false ? [outcome.error] : [],
    };
  }

  view(run: EmbeddedRun) {
    const { event: _event, writes: _writes, decisions: _decisions, errors: _errors, ...rest } = this.trace(run);
    return rest;
  }
}

function toJson(value: unknown): JsonValue {
  const round: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return round;
}

/** The embedded host's store, with its programs and runs where the authoring
 *  tools read them. */
export function authoringStore(now: () => Date) {
  const programs = new Programs(now);
  const runs = new Runs(now);
  const store: EmbeddedHostStore = {
    ...memoryEmbeddedHostStore({ now: () => now().getTime() }),
    programs: {
      put: async () => {
        throw new Error('this product saves movements through the authoring tools only');
      },
      list: async (tenant) => programs.list(tenant).map((k) => k.saved),
    },
    runs: { put: async (run) => runs.put(run), get: async (runId) => runs.byId(runId) },
  };
  return { store, programs, runs };
}

/** One customer's tools: its catalog, its movements, its runs. */
export function authoringTenant(input: { tenant: string; host: EmbeddedHost; store: EmbeddedHostStore; programs: Programs; runs: Runs }): TenantHost {
  const { tenant, host, store, programs, runs } = input;
  return {
    catalog: async ({ fresh }) => {
      if (fresh) host.schemaChanged(tenant);
      const connections = await store.connections.list(tenant);
      return { snapshot: await host.catalog(tenant), connections: connections.map(({ name, adapterType }) => ({ name, system: adapterType })) };
    },
    programs: {
      list: async () => programs.list(tenant).map((k) => k.program),
      get: async (ref) => programs.find(tenant, ref)?.program ?? null,
      save: async (write) => programs.write(tenant, write),
      delete: async () => false,
    },
    runs: {
      start: async () => ({ ok: false, error: "this product's movements run on its own events" }),
      status: async (runId) => {
        const run = runs.get(tenant, runId);
        return run === null ? null : runs.view(run);
      },
      list: async (program, { limit }) => runs.of(tenant, program.name).slice(0, limit).map((r) => runs.view(r)),
      trace: async (runId) => {
        const run = runs.get(tenant, runId);
        return run === null ? null : runs.trace(run);
      },
    },
  };
}

export type { Programs, Runs };
