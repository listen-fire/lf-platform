// The SUBJECT edge — the declared hop from an event to the record it is about
// (D40(b)). Two checks hung off it: `fields:` named properties of the RECORD,
// and a signature typed against the record when the listen fired the event got
// the exact rewrite. A 0.13 catalog no longer says what a settings listen
// takes or fires (catalog snapshot version 3), so neither is checked; such a
// listen checks clean.
//
// THREE differently-shaped mock adapters throughout, because a fixture that
// matches one adapter's shape cannot tell derived from hardcoded: `graph` and
// `flow` are both event-node-shaped but agree on NOTHING nameable (event type,
// subject edge, narrowing key, record type all differ), and `feed` fires the
// record directly.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { mockCatalog, type SchemaFieldType, type InstanceSchema, type PositionSchema } from '../catalog';
import { eventAddressDisplay, eventAddressKey, narrowingPrefixKey } from '../event_address';

const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];

/** An event-node-shaped instance, built from names the caller chooses — the
 *  host's graft (`listen_narrowing.ts`) in miniature: one grafted position per
 *  action, the subject edge retargeted at the record the pins walk to, and the
 *  deleted pin dropping it. */
function eventShaped(spec: {
  event: string;
  subjectEdge: string;
  narrowKey: string;
  meta: string;
  record: string;
  recordProps: Record<string, SchemaFieldType>;
}): InstanceSchema {
  const eventProps: Record<string, SchemaFieldType> = {
    action: { kind: 'enum', options: ACTIONS },
    [spec.narrowKey]: 'text',
  };
  const positions: Record<string, PositionSchema> = {
    [spec.record]: { properties: spec.recordProps, edges: {} },
    [spec.meta]: { properties: {}, edges: {}, undescribed: true },
    [spec.event]: {
      properties: eventProps,
      edges: {
        [spec.subjectEdge]: { target: spec.meta, subject: true, requiresLiveRecord: true },
      },
    },
  };
  const variants: string[] = [];
  for (const action of ACTIONS) {
    const narrowing = { action, [spec.narrowKey]: spec.record };
    const key = eventAddressKey({ event: spec.event, narrowing });
    variants.push(key);
    positions[key] = {
      properties: eventProps,
      edges:
        action === 'record.deleted'
          ? {}
          : { [spec.subjectEdge]: { target: spec.record, subject: true } },
      displayName: eventAddressDisplay({ event: spec.event, narrowing }),
    };
  }
  const wide = eventAddressKey({ event: spec.event, narrowing: { [spec.narrowKey]: spec.record } });
  return {
    positions,
    collections: {},
    unions: { [wide]: variants },
    writableRoots: {},
    eventPosition: spec.event,
    eventPositions: [{ position: spec.event }],
    eventNarrowingKeys: [spec.narrowKey],
    eventNarrowingValues: {
      [narrowingPrefixKey({})]: { [spec.narrowKey]: [spec.record, 'Something Else'] },
    },
  };
}

const GRAPH = eventShaped({
  event: 'Record Change',
  subjectEdge: 'Record',
  narrowKey: 'type',
  meta: 'Node Type',
  record: 'Support Ticket',
  recordProps: { Status: 'text', Priority: 'number' },
});

const FLOW = eventShaped({
  event: 'Change Notice',
  subjectEdge: 'Subject',
  narrowKey: 'collection',
  meta: 'Collection',
  record: 'Task',
  recordProps: { Owner: 'text', Due: 'date' },
});

/** The OTHER shape: a listen that fires the record itself. No subject edge, so
 *  `fields:` names the landed position's own properties and a record-typed
 *  signature is simply correct. */
const FEED: InstanceSchema = {
  positions: {
    'Meeting Note': { properties: { Title: 'text', Attendees: 'text' }, edges: {} },
  },
  collections: {},
  writableRoots: {},
  eventPosition: 'Meeting Note',
  eventPositions: [{ position: 'Meeting Note' }],
};

const listenSpec = (schema: InstanceSchema, narrowKey?: string) => ({
  constructionArgs: [],
  triggerConfig: [...(narrowKey === undefined ? [] : [narrowKey]), 'events', 'fields'],
  triggerConfigOptions: { events: ACTIONS },
  triggerConfigFormats: { fields: 'fields' as const },
  schema,
});

const catalog = mockCatalog({
  adapters: {
    kg: listenSpec(GRAPH, 'type'),
    tracker: listenSpec(FLOW, 'collection'),
    notes: listenSpec(FEED),
  },
});

const errors = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');

const program = (lines: string[]): string => lines.join('\n');

describe("`fields:` names the record the event is about", () => {
  it.each([
    ['kg', 'type', 'Support Ticket', 'Status', 'Record Change'],
    ['tracker', 'collection', 'Task', 'Owner', 'Change Notice'],
  ])('accepts a record property on %s', (adapter, key, record, field, event) => {
    expect(
      errors(
        program([
          `import { ${adapter} } from adapters`,
          `inst = connect ${adapter}`,
          `function m(e: <inst-[:\`${event}\` WHERE e.\`${key}\` == "${record}" && e.\`action\` == "record.created"]->>) { }`,
          `listen to inst { ${key}: "${record}", events: ["record.created"], fields: [${field}] } fire m`,
        ]),
      ),
    ).toEqual([]);
  });
});

describe('constructing an adapter shows the construction it really takes', () => {
  const withCreds = mockCatalog({
    adapters: {
      kg: { constructionArgs: [], schema: GRAPH },
      crm: {
        constructionArgs: [
          { name: 'credentials', kind: 'credential', required: true },
          { name: 'workspace', kind: 'position', required: false },
        ],
      },
    },
    credentials: { acme: { adapter: 'crm' } },
  });
  const unresolved = (name: string): string | undefined =>
    checkProgram(parseProgram(`function m() { write ${name}-[:X]-> { a: "b" } }`), withCreds)
      .find((d) => d.code === C.NAME_UNRESOLVED)?.message;

  it('shows no credential for an adapter that takes none', () => {
    expect(unresolved('kg')).toContain("'<name> = connect kg'");
  });

  it('shows the required argument for an adapter that needs one', () => {
    const msg = unresolved('crm');
    expect(msg).toContain("'<name> = connect crm using …'");
    // Optional args are not demanded.
    expect(msg).not.toContain('workspace');
  });

  it('a bare adapter as a WRITE root is loud, not silent', () => {
    // The legacy ambient-graph shape. It used to pass with no diagnostics at
    // all — the root had no position type, so the write body was never typed.
    const diags = errors(
      program([
        'import { kg } from adapters',
        'function m() {',
        '  write kg-[:`Support Ticket`]-> { Status: "Open" }',
        '}',
      ]),
    );
    const msg = diags.find((d) => d.code === C.ADAPTER_NOT_CONSTRUCTED)?.message;
    expect(msg).toContain("'kg' is an adapter, not an instance");
    expect(msg).toContain("'go = connect kg'");
  });

  it('a bare adapter as a TRAVERSAL root is loud too', () => {
    const diags = errors(
      program([
        'import { kg } from adapters',
        'function m() {',
        '  kg-[t:`Support Ticket`]-> { x = t.Status }',
        '}',
      ]),
    );
    expect(diags.map((d) => d.code)).toContain(C.ADAPTER_NOT_CONSTRUCTED);
  });

  it('a constructed instance as a root stays silent', () => {
    expect(
      errors(
        program([
          'import { kg } from adapters',
          'graph = connect kg',
          'function m() {',
          '  graph-[t:`Support Ticket`]-> { x = t.Status }',
          '}',
        ]),
      ).map((d) => d.code),
    ).not.toContain(C.ADAPTER_NOT_CONSTRUCTED);
  });
});
