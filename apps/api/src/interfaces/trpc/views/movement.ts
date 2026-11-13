/**
 * tRPC surface for the movement-script editor.
 *
 * Movements are TEXT-CANONICAL: the `automations.movement` row's `source`
 * column is the program; the movement engine executes it directly, and
 * the listener triggers are derived rows
 * (see services/translation_graph/movement/store.ts).
 *
 *   - `catalog` — the team's `CatalogSnapshot` SKELETON (movement-lang):
 *     adapters, credentials, plugins and kg from DB + manifests only — no
 *     external introspection, so it returns fast. The browser autocompletes
 *     OFFLINE against it, and checks a legacy pin against it too.
 *   - `check` — the lint for a release pin, whose checker (the wasm) is not
 *     in the browser: the same validation `save` gates on.
 *   - `describeInstance` — one (adapter, credential) pair's instance
 *     schema, introspected on demand (TTL-cached server-side). The editor
 *     requests these for the constructions the source references and
 *     merges them into its snapshot; diagnostics tighten as schemas
 *     arrive (the checker is silent on unknown schemas by design).
 *   - `save` — upsert the source row, then gate (checkProgram + the dry
 *     interpretability scan) + reconcile the file's derived listener
 *     triggers (one `automations.trigger` row per `listen` statement).
 *     Diagnostics come back alongside the saved row id; the text always
 *     survives.
 *   - `get` / `list` — read back the canonical source + runtime validity +
 *     derived listeners (channel, key, trigger id, run_mode) — round-trip:
 *     re-opening a movement shows the exact text that was saved.
 *     operational pause state); everything else is derived from the text.
 *     Both also carry the file's FACETS (automation/library, derived from
 *     the text — the source is canonical, so nothing kind-like is stored)
 *     and who imports it (`usedBy` count on list, full dependent list on
 *     get).
 *   - `delete` — remove the movement and every derived trigger.
 */

import { CreationStatementsInput } from '../../../services/access/stated_input';
import { seenOnlyBy } from '../../../services/access/decide';
import { TRPCError } from '@trpc/server';
import { currentPrincipal } from 'principal';
import {
  LANGUAGE_VERSION,
  neverAsAny,
  type Completions,
  type Definition,
  type HoverCard,
  type LanguageVersion,
} from 'movement-lang';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { currentContext } from '../../../services/context';
import { trpc } from '../trpc';
import { getQb, getAutomationsQb } from '../../../lib/kysely';
import { runCostSummaries } from '../../../lib/llm_usage';
import { summariseRun } from './triggers';
import {
  describeMovementInstance,
  movementCatalogSnapshotForTeam,
  type DescribedInstance,
  type TeamCatalogSnapshot,
} from '../../../services/translation_graph/movement/catalog';
import { callerAudience } from '../../../services/translation_graph/movement/audience';
import {
  deleteMovement,
  getMovement,
  listMovements,
  saveMovement,
  type MovementDetail,
  type MovementListenerInfo,
  type MovementListItem,
  type SaveMovementResult,
} from '../../../services/translation_graph/movement/provision';
import {
  getMovementRunStatus,
  nothingToRun,
  runMovementAsync,
  type MovementRunAsyncResult,
  type MovementRunStatus,
} from '../../../services/translation_graph/movement/run_now';
import {
  checkMovementDependentsOf,
  movementDependents,
  movementFileFacets,
  movementUsageIndex,
  type DependentCheckResult,
  type MovementDependent,
  type MovementFileFacets,
} from '../../../services/translation_graph/movement/files';
import {
  checkMovementSource,
  validateMovementForTeam,
  type AuthoringDiagnostic,
} from '../../../services/translation_graph/movement/authoring';
import {
  routeOf,
  type PinRoute,
} from '../../../services/translation_graph/movement/language_route';
import { providedFlagsFor } from '@listen-fire/language-versions';
import { CARRIED_RUN_NOW_NAME, carriedRunTriggerId } from '../../../services/translation_graph/movement/carried_run_now';
import {
  LEGACY_PRESENTATION_MESSAGE,
  completeAt,
  defineAt,
  hoverAt,
  type EditorAnswer,
} from '../../../services/translation_graph/movement/language_service';
import {
  storyViewForMovement,
  type StoryViewResult,
} from '../../../services/translation_graph/movement/story_view';
import { getMovementRow, listMovementRows } from '../../../services/translation_graph/movement/store';
import { reportedFailureReason } from '../../../services/translation_graph/runs/trigger_run';
import { UserService } from '../../../services/user';
import { movementEventsImpl, type MovementEventItem } from '../../../services/inbound/arrival_ledger';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { EXEMPT, USE_CONNECTION, decidesEach, readableAmong, seenAmong, unseen, type Decision } from '../../access_route';
import { cannotChange } from '../access';
import { Whose } from '../../../services/access/whose';

export type MovementRunItem = {
  id: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  nodesWritten: number;
  dryRun: boolean;
  summary: string;
  /** The lane (trigger name) that produced this run. */
  lane: string;
  /** Model-call cost this run incurred, rolled up from `llm_usage` — zero
   *  when the run made no model calls (or ran before cost tracking). */
  costMicrodollars: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Fetch all `trigger_run` rows for the triggers of a given movement, merged
 * across lanes and annotated with the originating trigger's name. Factored
 * out of the procedure for testability.
 */
export async function movementRunsImpl(params: {
  teamId: TeamId;
  movementId: string;
}): Promise<MovementRunItem[]> {
  const { teamId, movementId } = params;

  const triggerRows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', teamId)
    .where('movement_id', '=', movementId as MovementId)
    .select(['id', 'name'])
    .execute();

  // A run someone started on a carried version is recorded under the
  // movement's own id: there is no listen row for it.
  const triggerIds: string[] = [...triggerRows.map((r) => r.id), carriedRunTriggerId(movementId)];
  const laneByTriggerId = new Map<string, string>([
    ...triggerRows.map((r) => [r.id, r.name] as const),
    [carriedRunTriggerId(movementId), CARRIED_RUN_NOW_NAME] as const,
  ]);

  const runRows = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('trigger_id', 'in', triggerIds)
    .select([
      'id',
      'trigger_id',
      'status',
      'nodes_written',
      'dry_run',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  const costByRunId = await runCostSummaries(
    runRows.map((r) => r.id as unknown as TriggerRunId),
  );

  return runRows.map((row) => {
    const cost = costByRunId.get(row.id as unknown as string);
    return {
      id: row.id as unknown as string,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
      failureReason: reportedFailureReason(row),
      nodesWritten: row.nodes_written,
      dryRun: row.dry_run,
      summary: summariseRun({
        status: row.status,
        failed_at: row.failed_at,
        failure_reason: row.failure_reason,
        nodes_written: row.nodes_written,
      }),
      lane: laneByTriggerId.get(row.trigger_id as unknown as string) ?? '',
      costMicrodollars: cost?.costMicrodollars ?? 0,
      calls: cost?.calls ?? 0,
      inputTokens: cost?.inputTokens ?? 0,
      outputTokens: cost?.outputTokens ?? 0,
    };
  });
}

/**
 * Fetch the most recent `trigger_run` for each of the given trigger IDs,
 * keyed by trigger ID. Triggers with no runs are absent from the map.
 * Ordered by `created_at DESC`; the first row per trigger_id is the latest.
 */
export async function latestRunsByTriggerId(params: {
  teamId: TeamId;
  triggerIds: string[];
}): Promise<Map<string, MovementRunItem>> {
  const { teamId, triggerIds } = params;
  if (triggerIds.length === 0) return new Map();

  const rows = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('trigger_id', 'in', triggerIds)
    .select([
      'id',
      'trigger_id',
      'status',
      'nodes_written',
      'dry_run',
      'started_at',
      'completed_at',
      'failed_at',
      'failure_reason',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .execute();

  // First pass: pick the latest row per trigger (rows arrive newest-first).
  const latestRows: typeof rows = [];
  const seenTriggers = new Set<string>();
  for (const row of rows) {
    const triggerId = row.trigger_id as unknown as string;
    if (seenTriggers.has(triggerId)) continue;
    seenTriggers.add(triggerId);
    latestRows.push(row);
  }

  // Cost only for the runs that survived the dedup, not the whole history.
  const costByRunId = await runCostSummaries(
    latestRows.map((r) => r.id as unknown as TriggerRunId),
  );

  const result = new Map<string, MovementRunItem>();
  for (const row of latestRows) {
    const triggerId = row.trigger_id as unknown as string;
    const cost = costByRunId.get(row.id as unknown as string);
    result.set(triggerId, {
      id: row.id as unknown as string,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failedAt: row.failed_at,
      failureReason: reportedFailureReason(row),
      nodesWritten: row.nodes_written,
      dryRun: row.dry_run,
      summary: summariseRun({
        status: row.status,
        failed_at: row.failed_at,
        failure_reason: row.failure_reason,
        nodes_written: row.nodes_written,
      }),
      lane: '',
      costMicrodollars: cost?.costMicrodollars ?? 0,
      calls: cost?.calls ?? 0,
      inputTokens: cost?.inputTokens ?? 0,
      outputTokens: cost?.outputTokens ?? 0,
    });
  }
  return result;
}

/** A listener row enriched with the most recent run for that lane. */
type MovementListenerWithRun = MovementListenerInfo & {
  lastRun: MovementRunItem | null;
};

/** List rows carry the file's text-derived facets + who imports it. */
type MovementListItemResponse = Omit<MovementListItem, 'listeners'> & {
  locked: false;
  /** How many other files import this one. */
  usedBy: number;
  listeners: MovementListenerWithRun[];
  /** Whether only the caller may see it. */
  onlyYou: boolean;
};

/** An automation a team admin may not read, shown by its name alone: its lists are its access panel's. */
type LockedMovementListItem = { locked: true; id: string; name: string };

/**
 * How the editor treats a pin. `kind`: whose checker lints it (`legacy`: the
 * browser's; `installed`: the server's `check`, on the current version;
 * `carried`: the server's `check` too, by the pin's own earlier release the
 * platform carries; `refused`: nothing reads it). Completions, hover and
 * definition follow the same kind. Only the kind crosses to the browser.
 */
export interface MovementLanguageRoute {
  kind: 'legacy' | 'installed' | 'carried' | 'refused';
  /** For a carried pin, what its version provides on this platform: whether
   *  someone can run it (Run now, a test run), whether its parked runs
   *  resume, and whether its listens fire. */
  provides?: { run: boolean; resume: boolean; listen: boolean };
}

function languageRouteOf(pin: LanguageVersion): MovementLanguageRoute {
  const route: PinRoute = routeOf(pin);
  switch (route.kind) {
    case 'legacy':
    case 'installed':
    case 'refused':
      return { kind: route.kind };
    // The browser presents nothing of it, and its lint is the server's, which
    // answers with the frozen parser's verdict.
    case 'dropped':
      return { kind: 'refused' };
    case 'carried': {
      const { run, resume, listen } = providedFlagsFor(pin);
      return { kind: route.kind, provides: { run, resume, listen } };
    }
    default:
      return neverAsAny(route);
  }
}

/** The listens of a text on a carried version, as that version's parser read
 *  them. Stated here so the browser's types carry no version's package. */
interface MovementListen {
  instance: string;
  configKey: string | null;
  address: string | null;
  movement: string;
  startLine: number;
  endLine: number;
}
export interface MovementListenOutline {
  active: (MovementListen & { adapter: string | null; traversal: boolean })[] | null;
  paused: MovementListen[];
  adapters: Record<string, string> | null;
}

/** The skeleton, with the release a new movement is pinned to. */
export type MovementCatalogResponse = TeamCatalogSnapshot & {
  installed: { pin: LanguageVersion };
};

type MovementDetailResponse = MovementDetail & {
  facets: MovementFileFacets;
  /** The files importing this one (direct importers). */
  dependents: MovementDependent[];
  languageRoute: MovementLanguageRoute;
};

type SaveMovementResponse = SaveMovementResult & {
  /** After a shipped save: a fresh verdict for every file importing this
   *  one (their imports resolve the new text). Null on a failed save.
   *  Dependents' stored validity is never rewritten here. */
  dependentChecks: DependentCheckResult[] | null;
};

/** What the editor asks the language service: a position in a program, under
 *  the pin `check` reads it under. */
const editorPositionInput = z.object({
  source: z.string(),
  offset: z.number().int().nonnegative(),
  id: z.string().uuid().optional(),
  languageVersion: z.string().optional(),
});

function answered<T>(answer: EditorAnswer<T>, id: string | undefined): T {
  switch (answer.kind) {
    case 'answer':
      return answer.answer;
    case 'not-found':
      throw new TRPCError({ code: 'NOT_FOUND', message: `no movement ${id}` });
    case 'legacy-presentation':
      throw new TRPCError({ code: 'BAD_REQUEST', message: LEGACY_PRESENTATION_MESSAGE });
    default: {
      const unreachable: never = answer;
      throw new Error(`unhandled editor answer ${JSON.stringify(unreachable)}`);
    }
  }
}

/** An editor question about a saved movement the caller may not read is one about a movement that is not there. */
async function refuseUnseen(id: string | undefined): Promise<void> {
  if (id !== undefined && (await unseen(id))) throw new TRPCError({ code: 'NOT_FOUND', message: `no movement ${id}` });
}

function editorRequestOf(input: z.infer<typeof editorPositionInput>) {
  return {
    teamId: currentContext().user.teamId,
    audience: callerAudience(),
    source: input.source,
    offset: input.offset,
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
  };
}

const movementRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    catalog: userProcedure.query(async (): Promise<MovementCatalogResponse> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;
      const skeleton = await movementCatalogSnapshotForTeam(teamId, { audience: callerAudience() });
      // What a new movement is pinned to.
      return { ...skeleton, installed: { pin: LANGUAGE_VERSION } };
    }),

    /**
     * The server's lint for a pin the browser cannot check (an installed
     * release: its checker is the wasm, against the run snapshot). The pin is
     * the movement's when `id` is given, else `languageVersion`, else the
     * installed release. A MUTATION for the same reason as `catalogForSource`:
     * the program is the input.
     */
    check: userProcedure
      .input(
        z.object({
          source: z.string(),
          id: z.string().uuid().optional(),
          languageVersion: z.string().optional(),
        }),
      )
      .mutation(async ({ input }): Promise<{ diagnostics: AuthoringDiagnostic[] }> => {
        await refuseUnseen(input.id);
        const ctx = currentContext();
        const checked = await checkMovementSource({
          teamId: ctx.user.teamId,
          audience: callerAudience(),
          source: input.source,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
        });
        if (checked === null) throw new TRPCError({ code: 'NOT_FOUND', message: `no movement ${input.id}` });
        return checked;
      }),

    /**
     * The completions, hover card and definition at `offset` (UTF-16) for a
     * release pin: the wasm's language service against the run snapshot
     * `check` lints against. The pin is `check`'s. A legacy pin's language
     * service runs in the browser, so it is refused; a pin nothing reads gets
     * empty answers. MUTATIONS for `check`'s reason: the program is the input.
     */
    complete: userProcedure
      .input(editorPositionInput)
      .mutation(async ({ input }): Promise<Completions> => {
        await refuseUnseen(input.id);
        return answered(await completeAt(editorRequestOf(input)), input.id);
      }),

    hover: userProcedure
      .input(editorPositionInput)
      .mutation(async ({ input }): Promise<HoverCard | null> => {
        await refuseUnseen(input.id);
        return answered(await hoverAt(editorRequestOf(input)), input.id);
      }),

    definition: userProcedure
      .input(editorPositionInput)
      .mutation(async ({ input }): Promise<Definition | null> => {
        await refuseUnseen(input.id);
        return answered(await defineAt(editorRequestOf(input)), input.id);
      }),

    /**
     * The listens a program declares, read by its carried version's own parser:
     * that parser is not in the browser, so the listeners panel asks here for a
     * pin the browser cannot read. A MUTATION for `check`'s reason. A pin whose
     * text the browser reads has nothing to ask.
     */
    outline: userProcedure
      .input(z.object({ source: z.string(), id: z.string().uuid() }))
      .mutation(async ({ input }): Promise<MovementListenOutline> => {
        await refuseUnseen(input.id);
        const ctx = currentContext();
        const row = await getMovementRow({ teamId: ctx.user.teamId, id: input.id });
        if (row === null) throw new TRPCError({ code: 'NOT_FOUND', message: `no movement ${input.id}` });
        const route = routeOf(row.languageVersion);
        if (route.kind !== 'carried') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `language ${row.languageVersion} is not read through a carried version` });
        }
        const { active, paused, adapters } = (await route.lane()).outlineOf({ source: input.source, pin: route.pin });
        return { active, paused, adapters };
      }),

    /**
     * The same snapshot, TYPED FOR ONE PROGRAM: instance schemas filled by the
     * compile path, so the editor checks against exactly what `save` will
     * compute — including positioned instances (`spreadsheet:`) and narrowing
     * refinements (`WHERE \`Title\` == …`), neither of which the editor could
     * previously express.
     *
     * A MUTATION because a tRPC query serializes its input into the URL, and the
     * program is the input. It reads nothing and writes nothing; the verb is
     * about where the bytes ride, and the alternative — sending the names the
     * program mentions instead of the program — is what forced the editor to
     * assemble its own thinner schema in the first place.
     */
    catalogForSource: userProcedure
      .input(z.object({ source: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        return movementCatalogSnapshotForTeam(teamId, { audience: callerAudience(), source: input.source });
      }),

    describeInstance: userProcedure
      .input(
        z.object({
          /** Adapter slug (the construction's callee). */
          adapter: z.string(),
          /** Credential IMPORT name from the snapshot; omit for
           *  credential-free adapters like email. */
          credentialName: z.string().optional(),
          /**
           * Scope the (expensive) per-type describes to these type names.
           * Omitted still means the full surface — which is what the editor
           * asks for today, and the reason this endpoint was the last consumer
           * of the eager instance schema.
           *
           * The agent-facing REST route has had this (and `position`) all
           * along; the editor could not express a narrow question at all, so
           * it asked for everything on every construction. Exposing them here
           * is what lets the editor walk the same graph, by the same
           * addresses, as the agent.
           *
           */
          types: z.array(z.string()).optional(),
          /**
           * WHERE TO STAND — an address a previous call handed back, echoed
           * verbatim. Absent is the root. Never constructed by the caller: an
           * address is only ever learned by walking.
           */
          position: z.string().optional(),
          /**
           * The names the edited source mentions (`referencedNames(source)`).
           * Scopes the describes to the types actually named, so the editor and
           * the compiler agree on the schema for one source.
           *
           * NAMES, not the source: this is a query, so its input rides in the
           * URL and a movement of any size would overrun it.
           */
          mentions: z.array(z.string()).optional(),
          /** Skip the server's TTL cache and re-introspect. */
          forceRefresh: z.boolean().optional(),
        }),
      )
      .query(async ({ input }): Promise<DescribedInstance> => {
        const ctx = currentContext();
        return describeMovementInstance({
          teamId: ctx.user.teamId as TeamId,
          audience: callerAudience(),
          adapter: input.adapter,
          ...(input.credentialName !== undefined
            ? { credentialName: input.credentialName }
            : {}),
          ...(input.types !== undefined ? { types: input.types } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...(input.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {}),
        });
      }),

    save: userProcedure
      .input(
        z.object({
          source: z.string(),
          /** Existing movement row (the editor's re-save path). */
          id: z.string().uuid().optional(),
          /** Display name override; defaults to the declaration's name. */
          name: z.string().optional(),
          /** The updatedAt the editor loaded — for the concurrency guard.
           *  Omit to force an overwrite of whatever's stored. */
          baseUpdatedAt: z.string().optional(),
          /** Explicit consent to ship a non-valid save (the editor's
           *  "save anyway" confirmation). */
          acknowledgeErrors: z.boolean().optional(),
          /** Who may read and write it, when this save creates it. */
          statements: CreationStatementsInput.optional(),
          /** Set by a page that creates a new automation: a name already held is then refused as taken, never overwritten. */
          intent: z.literal('create').optional(),
        })
        .refine((input) => input.intent === undefined || input.id === undefined, {
          message: 'A save over an existing automation cannot also be a creation.',
        }),
      )
      .mutation(async ({ input }): Promise<SaveMovementResponse> => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId;
        const audience = callerAudience();
        const result = await saveMovement({
          teamId,
          source: input.source,
          audience,
          userId: ctx.user.id,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.baseUpdatedAt !== undefined ? { baseUpdatedAt: input.baseUpdatedAt } : {}),
          ...(input.acknowledgeErrors !== undefined
            ? { acknowledgeErrors: input.acknowledgeErrors }
            : {}),
          ...(input.statements !== undefined ? { statements: input.statements } : {}),
          ...(input.intent !== undefined ? { intent: input.intent } : {}),
        });

        // Dependent revalidation: a shipped save changes what files importing
        // this one resolve (imports read the saved TEXT), so re-check each
        // direct importer and report the verdicts with the save. Their
        // stored validity stays untouched — it's assessed by each file's
        // OWN saves and runs.
        if (!result.ok) return { ...result, dependentChecks: null };
        // Only the importers the saver may read are checked and named.
        const dependentChecks = await checkMovementDependentsOf({
          teamId,
          rows: await readableAmong(await listMovementRows(teamId), { automationOf: (row) => row.id, teamIds: [teamId] }),
          name: result.movementName,
          validate: (dependent) => validateMovementForTeam({ ...dependent, audience }),
        });
        return { ...result, dependentChecks };
      }),

    get: userProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }): Promise<MovementDetailResponse | null> => {
        if (await unseen(input.id)) return null;
        const ctx = currentContext();
        const teamId = ctx.user.teamId;
        const detail = await getMovement({ teamId, id: input.id });
        if (!detail) return null;
        const dependents = await readableAmong(await movementDependents({ teamId, name: detail.name }), {
          automationOf: (dependent) => dependent.id,
          teamIds: [teamId],
        });
        // Opening an automation on a carried version is what loads that version.
        const route = routeOf(detail.languageVersion);
        const facets =
          route.kind === 'carried'
            ? (await route.lane()).outlineOf({ source: detail.source, pin: route.pin }).facets
            : movementFileFacets(detail.source, detail.languageVersion);
        return {
          ...detail,
          facets,
          dependents,
          languageRoute: languageRouteOf(detail.languageVersion),
        };
      }),

    /**
     * The same movement, told as a story instead of shown as code: the
     * checked program projected to a `StoryIR` and joined with the display
     * vocabulary its systems declare, so the page that draws it names none
     * of them. Read-only, static (no run data), and it always carries the
     * movement's validity — an unreadable file gets a typed no-story rather
     * than a picture nobody checked.
     *
     */
    story: userProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }): Promise<StoryViewResult | null> => {
        if (await unseen(input.id)) return null;
        const ctx = currentContext();
        return storyViewForMovement({ teamId: ctx.user.teamId, id: input.id });
      }),

    list: userProcedure.query(async (): Promise<(MovementListItemResponse | LockedMovementListItem)[]> => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;
      const [listed, rows] = await Promise.all([
        listMovements(teamId),
        listMovementRows(teamId),
      ]);
      // An admin is shown every automation on the team; the ones they may not read, by name alone.
      const seen = await seenAmong(listed, { thing: 'automation', idOf: (item) => item.id, teamId });
      const items = seen.flatMap(({ item, locked }) => (locked ? [] : [item]));
      // Who imports a file counts only the importers the caller may read.
      const readable = new Set(items.map((item) => item.id));
      const usage = movementUsageIndex(rows.filter((row) => readable.has(row.id)));

      const allTriggerIds = items.flatMap((item) => item.listeners.map((l) => l.triggerId));
      const [latestRuns, onlyYours] = await Promise.all([
        latestRunsByTriggerId({ teamId, triggerIds: allTriggerIds }),
        seenOnlyBy(currentPrincipal(), { thing: 'automation', teamId, ids: items.map((item) => item.id) }),
      ]);

      return seen.map(({ item, locked }): MovementListItemResponse | LockedMovementListItem =>
        locked
          ? { locked: true, id: item.id, name: item.name }
          : {
              ...item,
              locked: false,
              usedBy: usage.get(item.name)?.length ?? 0,
              onlyYou: onlyYours.has(item.id),
              listeners: item.listeners.map((l) => ({
                ...l,
                lastRun: (() => {
                  const run = latestRuns.get(l.triggerId);
                  return run ? { ...run, lane: l.name } : null;
                })(),
              })),
            },
      );
    }),

    delete: userProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ input }): Promise<{ deleted: boolean }> => {
        if (await cannotChange(input.id)) return { deleted: false };
        const ctx = currentContext();
        const deleted = await deleteMovement({ teamId: ctx.user.teamId, id: input.id });
        return { deleted };
      }),

    /**
     * All runs for a movement, merged across its lanes (triggers), newest
     * first. Each item carries a `lane` — the trigger's name — so the caller
     * can group or filter by lane.
     */
    runs: userProcedure
      .input(z.object({ movementId: z.string().uuid() }))
      .query(async ({ input }): Promise<MovementRunItem[]> => {
        if (await unseen(input.movementId)) return [];
        const ctx = currentContext();
        return movementRunsImpl({
          teamId: ctx.user.teamId as TeamId,
          movementId: input.movementId,
        });
      }),

    /**
     * The arrival ledger: what reached the movement's listens, merged across
     * lanes, newest first — the runs arrivals started and the arrivals a listen
     * could not judge.
     */
    events: userProcedure
      .input(z.object({ movementId: z.string().uuid() }))
      .query(async ({ input }): Promise<MovementEventItem[]> => {
        if (await unseen(input.movementId)) return [];
        const ctx = currentContext();
        return movementEventsImpl({
          teamId: ctx.user.teamId as TeamId,
          movementId: input.movementId,
        });
      }),

    /**
     * "Run now" — queue an invocation event on the movement's MANUAL
     * channel (`go = manual()` + `listen to go {} fire <movement>`), through
     * normal trigger dispatch, and answer with the run's id at once; the run
     * happens on a worker and `runStatus` follows it. The event carries the
     * pressing member, so `@user_*` / `@actor_*` resolve to them; a listener
     * whose written instances are all `dry_run: true` rehearses (writes
     * captured, not committed). Real writes otherwise.
     */
    runNow: userProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          /** Free-form text supplied with the run (optional). */
          text: z.string().optional(),
          /** Files supplied with the run (optional). */
          files: z
            .array(
              z.object({
                filename: z.string().min(1),
                contentType: z.string().min(1),
                /** Base64-encoded file bytes. */
                contentBase64: z.string().min(1),
              }),
            )
            .optional(),
          /** One id per press: a retried request with the same id is the same
           *  run, never a second one. */
          requestId: z.string().min(1).max(200).optional(),
        }),
      )
      .mutation(async ({ input }): Promise<MovementRunAsyncResult> => {
        if (await cannotChange(input.id)) return nothingToRun({ movementId: input.id });
        const ctx = currentContext();
        const user = await UserService.getById(ctx.user.id);
        return runMovementAsync({
          teamId: ctx.user.teamId,
          movementId: input.id,
          text: input.text,
          files: input.files,
          actor: {
            email: user.email,
            ...(user.username !== null ? { name: user.username } : {}),
          },
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
      }),

    /** One run's status — what a Run-now press follows until it settles. */
    runStatus: userProcedure
      .input(z.object({ runId: z.string().uuid() }))
      .query(async ({ input }): Promise<MovementRunStatus | { error: string }> => {
        const ctx = currentContext();
        const owner = await Whose.automationOfRun({ runId: input.runId, teamIds: [ctx.user.teamId] });
        if (owner === undefined || (await unseen(owner.automationId))) return { error: `run ${input.runId} not found` };
        return getMovementRunStatus({ teamId: ctx.user.teamId, runId: input.runId });
      }),
  });
};

const READS: Decision = { thing: 'automation', verb: 'read' };
const WRITES: Decision = { thing: 'automation', verb: 'write' };

// An editor question names the saved movement whose pin it reads, when it names one.
decidesEach('movement', {
  catalog: USE_CONNECTION,
  check: READS,
  complete: READS,
  hover: READS,
  definition: READS,
  outline: READS,
  catalogForSource: USE_CONNECTION,
  describeInstance: USE_CONNECTION,
  save: EXEMPT.savedPerTarget,
  get: READS,
  story: READS,
  list: READS,
  delete: WRITES,
  runs: READS,
  events: READS,
  runNow: WRITES,
  runStatus: READS,
});

export { movementRouter };
