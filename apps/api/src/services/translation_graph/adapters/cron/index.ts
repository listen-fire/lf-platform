// Cron adapter — the time unit. A movement that should run on a schedule
// listens to the unit's one edge, its `Ticks`, naming the schedule (and,
// optionally, the IANA zone it is read in; absent, UTC):
//
//   listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1" AND t.Zone == "Europe/London"]-> fire digest
//
// `Ticks` is a polled listenable edge (adapter protocol 2.6): the edge poll
// worker (services/poll_source/worker.ts) polls it once per schedule and
// zone the listens name, and the unit answers the poll itself (`pollTicks`):
// every occurrence since the cursor, one arrival each. Source-only and
// credential-free: there is no external system. listen-fire's own cron unit
// answers the same (crates/lf/src/units.rs `poll_ticks`).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { Adapter, AdapterManifest, EdgesFromResult } from 'movement-engine/public/adapter';
import type { PollEdgeAnswer, PollEdgeInput } from 'module-kit';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from 'movement-engine/public/catalog';

import { uniformWalk } from 'module-kit/adapter/hop';
import { CRON_HANDBOOK_SECTION } from './handbook_section';
import { META_RECORD_TYPE, positionData } from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { describedType, type UnitSurface } from '../unit_surface';
import { CronParseError, cronMatches, nextCronOccurrence, parseCron, type CronSchedule } from 'legacy-lang/cron';

/** Stable adapter identifier — the trigger `kind` of cron-derived rows. */
export const CRON_ADAPTER_TYPE = 'cron';

/** Type id for the tick position a schedule firing seeds. Internal currency —
 *  stays lowercase; the natural name authors see is `CRON_TICK_DISPLAY_NAME`. */
export const CRON_TICK_TYPE_ID = 'tick';

/** Natural type name for a tick — TitleCase, like every other graph's nodes
 *  (adapters/CLAUDE.md). The event seed keys its position by this name (the
 *  address is the natural node name, layer 8), so field reads resolve it
 *  through the resolver; the typeId stays stable. */
export const CRON_TICK_DISPLAY_NAME = 'Tick';

/** The unit's one edge: a schedule's ticks, polled. */
export const CRON_TICKS_EDGE = 'Ticks';

/** How often `Ticks` is polled: a tick fires within this of its time. */
export const CRON_POLL_EVERY_SECONDS = 60;

/** The zone a schedule is read in when a listen names none. */
const DEFAULT_ZONE = 'UTC';

/** What a tick's landing carries, by field id. */
export interface CronTickPayload {
  /** The scheduled occurrence this tick fired for (ISO, UTC). */
  firedAt: string;
  /** The listen's schedule. */
  schedule: string;
  /** The zone the schedule was read in. */
  zone: string;
}

/** Static manifest. Source-only, credential-free. A 0.12 settings listen
 *  (`listen to timer { schedule, timezone }`) is written as a traversal on
 *  `Ticks` by `listenSettingsBecome`. */
export const CRON_MANIFEST: AdapterManifest = {
  adapterType: CRON_ADAPTER_TYPE,
  displayName: 'Schedule',
  description:
    'Time as a source. A schedule ticks when it comes due, and a movement ' +
    'listening to its ticks runs — weekly digests, nightly mirrors. Built ' +
    'in; nothing to connect.',
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue'],
  // Self-alias: the provider key stays the lowercase slug (there is no
  // legacy uppercase channel for an intrinsic adapter).
  triggerKinds: [CRON_ADAPTER_TYPE],
  listenSettingsBecome: {
    path: [CRON_TICKS_EDGE],
    aliases: ['t'],
    paramFrom: CRON_TICK_DISPLAY_NAME,
    keys: {
      schedule: { hop: 0, field: 'Schedule', op: 'eq' },
      timezone: { hop: 0, field: 'Zone', op: 'eq' },
    },
  },
  triggerExpectation:
    'Fires on the schedule its listen names (a cron expression) — nothing ' +
    'external triggers it, and the tick carries only its time and schedule. ' +
    'Present it as periodic work, never as reacting to data changes.',
  handbookSection: CRON_HANDBOOK_SECTION,
  vocabulary: {
    // A built-in owns no brand, but it still owns a MARK — see the manual
    // adapter for why. A clock is the whole of what this source is.
    icon: {
      d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18 M12 7.5 V12 l3.2 1.9',
      fill: false,
    },
  },
};

/** What a cron instance publishes and every type it describes. It is
 *  fixed data, so a catalog that cannot ask the adapter (the static one
 *  tests check against) projects the surface the adapter answers. */
export const CRON_SURFACE: UnitSurface = {
  // The natural name (`Tick`, TitleCase) is the currency authors, the
  // checker, and the hover all use; the internal `tick` typeId lives only in
  // this adapter's private cache. They no longer need to be identical: the
  // event edge keys its seed position by the natural node NAME (the address,
  // layer 8), and describe accepts either spelling — so field reads resolve
  // through the resolver whichever way the seed is stamped.
  entries: [
    {
      typeId: CRON_TICK_TYPE_ID,
      displayName: CRON_TICK_DISPLAY_NAME,
      writable: false,
      // Nothing enumerates ticks: each is an arrival on `Ticks`, polled.
      readable: false,
      collectionName: CRON_TICKS_EDGE,
      listenable: true,
      // Every schedule's ticks: only a filter on its schedule bounds it.
      bounded: false,
      boundedBy: ['Schedule'],
      delivery: 'polled',
      pollEverySeconds: CRON_POLL_EVERY_SECONDS,
      cursor: true,
      capability: { filter: 'native', supportsLimit: false },
    },
  ],
  /**
   * The smallest graph there is: a schedule, and the tick it delivers. Nothing
   * enumerates ticks, so the single edge leaving the root is one you are fired
   * along — which is the honest shape of a timer, not a gap in it.
   */
  root: {
    typeId: META_RECORD_TYPE,
    displayName: 'Schedule',
    description:
      'A schedule. There is nothing here to list — a schedule holds no data; ' +
      'it fires, and the tick it delivers is the only way in.',
    fields: [],
    references: [
      {
        fieldId: CRON_TICK_TYPE_ID,
        targetTypeId: CRON_TICK_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: CRON_TICKS_EDGE,
        listenable: true,
        readable: false,
        description: "A schedule's ticks — what a listen is fired by.",
      },
    ],
  },
  types: [
    {
      typeId: CRON_TICK_TYPE_ID,
      displayName: CRON_TICK_DISPLAY_NAME,
      description: 'One scheduled firing — when it was due, on which schedule, in which zone.',
      fields: [
        { fieldId: 'firedAt', displayName: 'Fired at', kind: 'date', writable: false, required: true, description: 'The scheduled occurrence this tick fired for (UTC).' },
        // Scalars only the unit reads, compared by `==` or `IN`.
        {
          fieldId: 'schedule',
          displayName: 'Schedule',
          kind: 'owned',
          owned: { name: 'Cron', format: 'cron' },
          writable: false,
          required: true,
          capability: { filterOperators: ['eq', 'in'] },
          description: 'The cron schedule that produced this tick (five fields).',
        },
        {
          fieldId: 'zone',
          displayName: 'Zone',
          kind: 'owned',
          owned: { name: 'Zone', format: 'timeZone' },
          writable: false,
          required: true,
          capability: { filterOperators: ['eq', 'in'] },
          description: 'The IANA zone the schedule is read in (UTC when the listen names none).',
        },
      ],
      references: [],
    },
  ],
};

export class CronAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = CRON_ADAPTER_TYPE;
  readonly supportedTriggers = CRON_MANIFEST.supportedTriggers;
  /** Unstable tick positions resolve to the tick type. */
  readonly webhookEventTypeId = CRON_TICK_TYPE_ID;

  // teamId is accepted for parity with other adapters; cron has no
  // per-team configuration.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly teamId: TeamId) {
    super();
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [...CRON_SURFACE.entries];
  }

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: CRON_ADAPTER_TYPE,
      at: position,
      root: CRON_SURFACE.root,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    return describedType(CRON_SURFACE, await this.resolveTypeRef(typeRef));
  }

  async getFieldValue(input: { position: SourcePosition; fieldId: string }): Promise<unknown> {
    if (input.position.adapterType !== CRON_ADAPTER_TYPE) {
      throw new Error(
        `CronAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    // The program names the field by its NATURAL displayName ('Fired at',
    // 'Schedule'); the payload is keyed by the internal field id (`firedAt`,
    // `schedule`). Resolve natural→internal against the position's natural type
    // on the first line (Decision #3).
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const payload = (positionData(input.position) ?? {}) as Partial<CronTickPayload>;
    return (payload as Record<string, unknown>)[fieldId] ?? null;
  }

  /** A poll of `Ticks` (adapter protocol 2.6), answered by the unit itself. */
  async poll(input: PollEdgeInput): Promise<PollAgainAnswer> {
    return pollTicks(input, { now: new Date(), everyMs: CRON_POLL_EVERY_SECONDS * 1000 }).answer;
  }
}

type Arrival = PollEdgeAnswer['arrivals'][number];

/** The literals `filter` compares `field` with by `==` or `IN`, or an OR of
 *  `==`; undefined when it names none (the checker refuses any other form
 *  on a field only the unit reads). The field is named as the program
 *  writes it, or by its id. */
export function valuesOf(filter: unknown, field: { name: string; id: string }): string[] | undefined {
  if (typeof filter !== 'object' || filter === null) return undefined;
  const type: unknown = Reflect.get(filter, 'type');
  const op: unknown = Reflect.get(filter, 'op');
  if (type === 'logical') {
    const operands: unknown = Reflect.get(filter, 'operands');
    if (!Array.isArray(operands)) return undefined;
    const each = operands.map((operand) => valuesOf(operand, field));
    if (op === 'and') return each.find((values) => values !== undefined);
    if (op === 'or') return each.every((values) => values !== undefined) ? each.flatMap((values) => values ?? []) : undefined;
    return undefined;
  }
  if (type !== 'compare') return undefined;
  const left: unknown = Reflect.get(filter, 'left');
  const leftType: unknown = typeof left === 'object' && left !== null ? Reflect.get(left, 'type') : undefined;
  const property: unknown = typeof left === 'object' && left !== null ? Reflect.get(left, 'propertyTypeId') : undefined;
  // A listen's plan names the field as the edge's own (`edge_property`), as
  // listen-fire's planner writes it.
  if ((leftType !== 'property' && leftType !== 'edge_property' && leftType !== 'edgeProperty') || (property !== field.name && property !== field.id)) return undefined;
  const right: unknown = Reflect.get(filter, 'right');
  if (typeof right !== 'object' || right === null) return undefined;
  const literal = (element: unknown): string | undefined => {
    if (typeof element === 'string') return element;
    if (typeof element !== 'object' || element === null || Reflect.get(element, 'type') !== 'static') return undefined;
    const value: unknown = Reflect.get(element, 'value');
    return typeof value === 'string' ? value : undefined;
  };
  const listed = (elements: unknown[]): string[] | undefined => {
    const values = elements.map((element) => {
      const inner: unknown = typeof element === 'object' && element !== null && 'expression' in element ? Reflect.get(element, 'expression') : element;
      return literal(inner);
    });
    return values.every((value): value is string => value !== undefined) ? values : undefined;
  };
  if (op === 'eq') {
    const value = literal(right);
    return value === undefined ? undefined : [value];
  }
  if (op === 'in') {
    const value: unknown = Reflect.get(right, 'value');
    if (Reflect.get(right, 'type') === 'static' && Array.isArray(value)) return listed(value);
    const elements: unknown = Reflect.get(right, 'elements');
    if (Array.isArray(elements)) return listed(elements);
  }
  return undefined;
}

/** A poll's answer as adapter protocol 2.7 has it: it may say when the edge
 *  is next worth polling (`pollAgainAt`, an ISO instant). */
export type PollAgainAnswer = PollEdgeAnswer & { pollAgainAt?: string };

/** What a poll of `Ticks` answered, and a line for each schedule and zone it
 *  could not read (that pair fires nothing; the rest of the poll still does). */
export interface Ticked {
  answer: PollAgainAnswer;
  unread: string[];
}

const MINUTE_MS = 60_000;

/** The earliest occurrence after `afterMs` and no later than `untilMs`, when
 *  there is one (a bounded walk, where nextCronOccurrence walks years). */
function nextWithin(schedule: CronSchedule, afterMs: number, untilMs: number): number | undefined {
  for (let at = afterMs - (afterMs % MINUTE_MS) + MINUTE_MS; at <= untilMs; at += MINUTE_MS) {
    if (cronMatches(schedule, new Date(at))) return at;
  }
  return undefined;
}

/** No more than this many occurrences of one schedule are walked to find the
 *  latest of a backlog. */
const BACKLOG_WALK_LIMIT = 100_000;

/**
 * The unit's answer to a poll of `Ticks`: every occurrence since the cursor of
 * each schedule and zone the filter names, one arrival each. An occurrence
 * older than one poll interval before now was missed while nothing polled (a
 * backlog): of those only the latest fires, once. One instant fires once
 * however many spellings name it. Its identity is the occurrence, so however
 * many workers find it due, a listen runs it once. The first poll (no cursor)
 * only sets the cursor. The cursor is the instant it polled to. The unit
 * applies the filter itself (`takenApplied`).
 *
 * Each answer, the first included, says when the next occurrence is due
 * (`pollAgainAt`, adapter protocol 2.7), so the host polls then rather than
 * up to an interval after it. It looks no further than one interval ahead:
 * the host polls by then anyway.
 */
export function pollTicks(input: PollEdgeInput, clock: { now: Date; everyMs: number }): Ticked {
  const nowMs = clock.now.getTime();
  const cursor = typeof input.cursor === 'string' ? Date.parse(input.cursor) : Number.NaN;
  if (input.edge !== CRON_TICKS_EDGE) throw new Error(`cron: no edge ${input.edge} to poll (its one edge is ${CRON_TICKS_EDGE})`);
  const schedules = valuesOf(input.filter, { name: 'Schedule', id: 'schedule' });
  if (schedules === undefined) throw new Error(`cron: a poll of ${CRON_TICKS_EDGE} names no schedule it can read`);
  const zones = valuesOf(input.filter, { name: 'Zone', id: 'zone' }) ?? [DEFAULT_ZONE];
  const unread: string[] = [];
  const clocks: Array<{ schedule: string; zone: string; parsed: CronSchedule }> = [];
  for (const schedule of schedules) {
    for (const zone of zones) {
      try {
        clocks.push({ schedule, zone, parsed: parseCron(schedule, { timezone: zone }) });
      } catch (error) {
        if (!(error instanceof CronParseError)) throw error;
        unread.push(`cron: schedule "${schedule}" in ${zone} fires nothing: ${error.message}`);
      }
    }
  }
  const next = clocks
    .map(({ parsed }) => nextWithin(parsed, nowMs, nowMs + clock.everyMs))
    .filter((at): at is number => at !== undefined)
    .reduce<number | undefined>((soonest, at) => (soonest === undefined || at < soonest ? at : soonest), undefined);
  const answer = (arrivals: Arrival[]): PollAgainAnswer => ({
    arrivals,
    cursor: clock.now.toISOString(),
    ...(next !== undefined ? { pollAgainAt: new Date(next).toISOString() } : {}),
  });
  if (Number.isNaN(cursor)) return { answer: answer([]), unread };
  const backlogUntil = nowMs - clock.everyMs;
  const due = new Map<number, { schedule: string; zone: string }>();
  for (const { schedule, zone, parsed } of clocks) {
    const at: number[] = [];
    let from = cursor;
    if (cursor < backlogUntil) {
      let latest: number | undefined;
      for (let walked = 0; walked < BACKLOG_WALK_LIMIT; walked++) {
        const occurrence = nextCronOccurrence(parsed, new Date(from));
        if (occurrence === null || occurrence.getTime() > backlogUntil) break;
        latest = occurrence.getTime();
        from = latest;
      }
      if (latest !== undefined) at.push(latest);
      from = Math.max(from, backlogUntil);
    }
    for (let occurrence = nextCronOccurrence(parsed, new Date(from)); occurrence !== null && occurrence.getTime() <= nowMs; occurrence = nextCronOccurrence(parsed, occurrence)) {
      at.push(occurrence.getTime());
    }
    for (const instant of at) if (!due.has(instant)) due.set(instant, { schedule, zone });
  }
  const arrivals: Arrival[] = [...due.entries()]
    .sort(([a], [b]) => a - b)
    .map(([instant, { schedule, zone }]) => {
      const firedAt = new Date(instant).toISOString();
      const fields: CronTickPayload = { firedAt, schedule, zone };
      return {
        edge: CRON_TICKS_EDGE,
        identity: `tick:${schedule}:${zone}:${firedAt}`,
        landing: { recordType: CRON_TICK_DISPLAY_NAME, fields: { ...fields } },
        occurredAt: firedAt,
        takenApplied: true,
      };
    });
  return { answer: answer(arrivals), unread };
}

/** Factory matching the registry's AdapterFactory signature. */
export function createCronAdapter(input: { teamId: TeamId }): CronAdapter {
  return new CronAdapter(input.teamId);
}
