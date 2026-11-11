// Who acted, as the platform writes it before a filter is judged: the module's
// first originator, else the actor the arrival names, normalised as listen-fire
// normalises it, with `Member` and `User` from the team's users. Nothing is
// asked when no text says `Actor`, no run waiting on the edge reads it and the
// fire statement is anyone; a lookup that fails leaves the arrival unjudged; a
// module's own `Actor` wins. Beside the arrivals, what was decided for each.
//
// The listen is planned the real way: a module's schema through the catalog's
// graft, a text checked against it, its plan judged by the engine's judge.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION, checkSourceInRust, parseProgram, type CatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';
import { logger } from 'movement-engine/public/log';

import type { ActorCandidate, Arrival } from 'engine-contracts';
import type { SchemaTypeDescriptor } from 'engine-contracts/catalog';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

jest.mock('../../../lib/kysely', () => ({ getAutomationsQb: jest.fn(), getCoreQb: jest.fn() }));
jest.mock('../../translation_graph/adapters/registry', () => ({ getAdapterManifest: jest.fn() }));
jest.mock('../../translation_graph/adapters/resolve', () => ({ resolveAdapter: jest.fn() }));
jest.mock('../../movement_engine/run_host_deliveries', () => ({ deliveryRowStore: jest.fn() }));
jest.mock('../../access/statement', () => ({ StatementStore: { grantsAmong: jest.fn() } }));
jest.mock('../../translation_graph/adapters/email/public_inbox', () => ({ publicInboxActor: jest.fn() }));
jest.mock('../../translation_graph/adapters/acting_user_shared', () => ({
  applyCreatorOverride: jest.fn(async () => ({ overridden: false })),
  loadActingUserById: jest.fn(),
  readCreatorFallbackConfig: jest.fn(() => false),
  lookupTeamUserByEmail: jest.fn(),
  lookupTeamUserByPhone: jest.fn(),
}));

import { getAutomationsQb as getAutomationsQbImport } from '../../../lib/kysely';
import { getAdapterManifest as getAdapterManifestImport } from '../../translation_graph/adapters/registry';
import { resolveAdapter as resolveAdapterImport } from '../../translation_graph/adapters/resolve';
import { StatementStore } from '../../access/statement';
import { lookupTeamUserByEmail as lookupTeamUserByEmailImport } from '../../translation_graph/adapters/acting_user_shared';
import { plannedListensOfSource } from '../../translation_graph/movement/listen_plans';
import { invocationArrival } from '../../translation_graph/adapters/manual';
import { ACTOR, ACTOR_TYPE, automationReadsActor, graftActorField, withActors } from '../actors';
import { judgeArrivals, type SavedListen } from '../listen_door';

const getAutomationsQb = getAutomationsQbImport as jest.Mock;
const resolveAdapter = resolveAdapterImport as jest.Mock;
const lookupTeamUserByEmail = lookupTeamUserByEmailImport as jest.Mock;
const grantsAmong = StatementStore.grantsAmong as jest.Mock;
const getAdapterManifest = getAdapterManifestImport as jest.Mock;

const TEAM = randomUUID() as TeamId;
const ADA = { id: randomUUID(), email: 'ada@x.com', name: 'Ada' };

// A chat module whose messages arrive on `Messages`, reporting who posted.
const entries = [{ typeId: 'msg', displayName: 'Message', collectionName: 'Messages', readable: false, writable: false, listenable: true }];
const message = (fields: SchemaTypeDescriptor['fields']): SchemaTypeDescriptor => ({ typeId: 'msg', displayName: 'Message', fields, references: [] });
const TEXT = { fieldId: 'text', displayName: 'Text', kind: 'string', writable: false, required: false } as const;

function chatSchema(descriptor = message([TEXT])): InstanceSchema {
  return instanceSchemaFromDescriptors({ adapterType: 'chat', entries, descriptors: new Map([['msg', descriptor]]), supportsInPlaceUpdate: false }).schema;
}

const REPORTS = ['getActorCandidates', 'extractActor'];

const textOf = (where: string) =>
  `import { chat } from adapters\nc = connect chat\nfunction f(m: <c-[:Messages]->>) {\n  return m.Text\n}\nlisten to c-[m:Messages WHERE ${where}]-> fire f\n`;

const snapshotOf = (schema: InstanceSchema): CatalogSnapshot => ({ adapters: { chat: { constructionArgs: [], schemas: { '': schema } } }, credentials: {}, plugins: {} });

/** The checker's errors on a listen over `schema`. */
function errorsOver(schema: InstanceSchema, where: string): string[] {
  return checkSourceInRust(textOf(where), snapshotOf(schema), { languageVersion: LANGUAGE_VERSION })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

/** A listen saved as a save saves it: whether its automation reads `Actor`
 *  is decided by the save's own computation, over a text that imports nothing. */
async function listenOver(schema: InstanceSchema, where: string): Promise<SavedListen> {
  expect(errorsOver(schema, where)).toEqual([]);
  const source = textOf(where);
  const snapshot = snapshotOf(schema);
  const readsActor = await automationReadsActor({ source, resolveFile: () => undefined });
  const { listens, refused } = plannedListensOfSource({ file: 'chat.lf', source, program: parseProgram(source), snapshot, pin: LANGUAGE_VERSION, readsActor });
  expect(refused).toEqual([]);
  const [planned] = listens;
  if (planned === undefined) throw new Error('the text planned no listen');
  return { ...planned, triggerId: randomUUID() as TriggerId, teamId: TEAM, file: 'chat.lf', credentialsId: null };
}

const offered = () => graftActorField({ adapterType: 'chat', methods: REPORTS, schema: chatSchema() });

/** A message from Slack user `U1`, whom the source system vouched for. */
function posted(user = 'U1'): Exclude<Arrival, { gone: true }> {
  return {
    edge: 'Messages',
    identity: `m-${user}`,
    landing: { recordType: 'Message', fields: { text: 'hi' } },
    actor: { identifier: user, scheme: 'opaque', adapterType: 'chat', label: user, proven: true },
  };
}

const originator = (email: string, identifier = 'U1'): ActorCandidate => ({ identity: { identifier, scheme: 'email', adapterType: 'chat', email }, source: 'originator' });

const delivered = { adapterType: 'chat', credentialsId: null };

let getActorCandidates: jest.Mock;

let triggers: { movement_id: string | null }[] = [];
let waitedOn: { edge: string }[] = [];

/** The trigger rows `fireStatementNeedsActor` reads, as Kysely chains them. */
function triggerRows(rows: { movement_id: string | null }[]): void {
  triggers = rows;
}

/** The edges that runs of an automation reading `Actor` wait on (`wait_row`, by the version each run pins). */
function waitsOn(edges: string[]): void {
  waitedOn = edges.map((edge) => ({ edge }));
}

/** One query, as Kysely chains it: its rows are the table it selects from. */
function query(table: string) {
  const rows = () => (table === 'wait_row' ? waitedOn : triggers);
  const chain = { select: () => chain, where: () => chain, innerJoin: () => chain, distinct: () => chain, execute: async () => rows() };
  return chain;
}

const fieldsOf = (arrival: Arrival | undefined) => (arrival !== undefined && !('gone' in arrival) ? arrival.landing.fields : undefined);

beforeEach(() => {
  jest.clearAllMocks();
  getActorCandidates = jest.fn(async () => [originator('Ada@X.com')]);
  resolveAdapter.mockResolvedValue({ getActorCandidates });
  lookupTeamUserByEmail.mockImplementation(async ({ email }: { email: string }) => (email.toLowerCase() === ADA.email ? ADA : null));
  getAutomationsQb.mockReturnValue({ selectFrom: query });
  getAdapterManifest.mockReturnValue(undefined);
  triggerRows([]);
  waitsOn([]);
  grantsAmong.mockResolvedValue(new Map());
});

describe('graftActorField', () => {
  it('offers Actor on each landing of a module that reports who acted, and names it in the field ids', () => {
    const schema = offered();

    expect(schema.positions.Message?.properties[ACTOR]).toEqual({ kind: 'maybeAbsent', of: { kind: 'record', position: { kind: 'position', position: ACTOR_TYPE } } });
    expect(schema.positions.Message?.fieldIds).toEqual({ ...chatSchema().positions.Message?.fieldIds, [ACTOR]: ACTOR });
    expect(Object.keys(schema.positions[ACTOR_TYPE]?.properties ?? {})).toEqual(['Id', 'Email', 'Domain', 'Phone', 'Name', 'Proven', 'Member', 'User']);
  });

  it('a filter reads it as a record that may be absent, which it cannot without the offer', () => {
    expect(errorsOver(offered(), 'm.Actor?.Email == "ada@x.com" && m.Actor?.Member == true')).toEqual([]);
    expect(errorsOver(chatSchema(), 'm.Actor?.Email == "ada@x.com"')).not.toEqual([]);
  });

  it('leaves the schema it was handed as it was', () => {
    const base = chatSchema();
    const before = JSON.stringify(base);

    graftActorField({ adapterType: 'chat', methods: REPORTS, schema: base });

    expect(JSON.stringify(base)).toEqual(before);
  });

  it('offers nothing on a module that reports nobody', () => {
    const base = chatSchema();

    expect(graftActorField({ adapterType: 'chat', methods: ['getFieldValue'], schema: base })).toBe(base);
  });

  it('offers nothing on a landing with an Actor of its own', () => {
    const base = chatSchema(message([TEXT, { fieldId: 'fldActor', displayName: 'Actor', kind: 'string', writable: false, required: false }]));

    const schema = graftActorField({ adapterType: 'chat', methods: REPORTS, schema: base });

    expect(schema).toBe(base);
    expect(schema.positions.Message?.properties[ACTOR]).toBe('text');
  });
});

describe('withActors', () => {
  it('writes who posted a Slack message: their address, its domain, that they are a member and which user', async () => {
    const listen = await listenOver(offered(), 'm.Actor?.Email == "ada@x.com"');

    const { arrivals, actors } = await withActors([posted()], { team: TEAM, listens: [listen], adapter: delivered });

    const actor = { Id: 'U1', Email: 'ada@x.com', Domain: 'x.com', Name: 'U1', Proven: true, Member: true, User: ADA.id };
    expect(fieldsOf(arrivals[0])?.[ACTOR]).toEqual(actor);
    expect(actors).toEqual([{ kind: 'written', actor, addressMatch: { user: ADA.id, vouched: true } }]);
    expect(judgeArrivals({ listens: [listen], delivery: delivered, arrivals, now: new Date() }).minted).toHaveLength(1);
  });

  it("an email from a member's address is no member and names no user, though the decision still names the matched user as unvouched", async () => {
    const email = { ...posted(), actor: { identifier: 'ada@x.com', scheme: 'email' as const, adapterType: 'chat', label: 'ada@x.com', proven: false } };
    getActorCandidates.mockResolvedValue([originator('ada@x.com', 'ada@x.com')]);
    const listen = await listenOver(offered(), 'm.Actor?.Member == true');

    const { arrivals, actors } = await withActors([email], { team: TEAM, listens: [listen], adapter: delivered });

    const actor = { Id: 'ada@x.com', Email: 'ada@x.com', Domain: 'x.com', Name: 'ada@x.com', Proven: false, Member: false };
    expect(fieldsOf(arrivals[0])?.[ACTOR]).toEqual(actor);
    expect(actors).toEqual([{ kind: 'written', actor, addressMatch: { user: ADA.id, vouched: false } }]);
    expect(judgeArrivals({ listens: [listen], delivery: delivered, arrivals, now: new Date() }).minted).toEqual([]);
  });

  it('a stranger is no member, and has no user', async () => {
    getActorCandidates.mockResolvedValue([originator('eve@evil.com', 'U9')]);
    const listen = await listenOver(offered(), 'm.Actor?.Member == true');

    const { arrivals, actors } = await withActors([posted('U9')], { team: TEAM, listens: [listen], adapter: delivered });

    const actor = { Id: 'U9', Email: 'eve@evil.com', Domain: 'evil.com', Name: 'U9', Proven: true, Member: false };
    expect(fieldsOf(arrivals[0])?.[ACTOR]).toEqual(actor);
    expect(actors).toEqual([{ kind: 'written', actor }]);
    expect(judgeArrivals({ listens: [listen], delivery: delivered, arrivals, now: new Date() }).minted).toEqual([]);
  });

  it('takes an address only from an originator who is the same person the arrival named', async () => {
    getActorCandidates.mockResolvedValue([originator('ada@x.com', 'U7')]);
    const listen = await listenOver(offered(), 'm.Actor?.Member == true');

    const { actors } = await withActors([posted()], { team: TEAM, listens: [listen], adapter: delivered });

    expect(actors).toEqual([{ kind: 'written', actor: { Id: 'U1', Name: 'U1', Proven: true, Member: false } }]);
  });

  it('saves a listen whose text never says Actor as not reading it, and asks nothing, though the catalog offered it', async () => {
    const listen = await listenOver(offered(), 'm.Text == "hi"');
    const automation = randomUUID();
    triggerRows([{ movement_id: automation }]);
    grantsAmong.mockResolvedValue(new Map([[automation, [{ verb: 'fire', grantee: { kind: 'anyone' } }]]]));
    const arrival = posted();

    expect(listen.readsActor).toBeUndefined();
    expect((await listenOver(offered(), 'm.Actor?.Member == true')).readsActor).toBe(true);
    expect(await withActors([arrival], { team: TEAM, listens: [listen], adapter: delivered })).toEqual({ arrivals: [arrival], actors: [{ kind: 'unneeded' }] });
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(lookupTeamUserByEmail).not.toHaveBeenCalled();
  });

  describe('a fired function imported from another file', () => {
    const listenFiring = 'import { chat } from adapters\nimport { f } from "lib.lf"\nc = connect chat\nlisten to c-[m:Messages]-> fire f\n';

    async function savedWith(files: Record<string, string>): Promise<boolean> {
      const resolveFile = (path: string) => (path in files ? { source: files[path] } : undefined);
      const readsActor = await automationReadsActor({ source: listenFiring, resolveFile });
      const snapshot = snapshotOf(chatSchema());
      const planned = plannedListensOfSource({ file: 'chat.lf', source: listenFiring, program: parseProgram(listenFiring), snapshot, pin: LANGUAGE_VERSION, readsActor });
      expect(planned.listens).toHaveLength(1);
      return planned.listens[0]?.readsActor === true;
    }

    it('saves a listen as reading Actor when the imported file reads it, even one file further in', async () => {
      expect(await savedWith({ 'lib.lf': 'import { f } from "deeper.lf"\n', 'deeper.lf': 'export function f(m) { return m.Actor?.Email }\n' })).toBe(true);
    });

    it('saves it as not reading Actor when no imported file does', async () => {
      expect(await savedWith({ 'lib.lf': 'export function f(m) { return m.Text }\n' })).toBe(false);
    });

    it('saves it as reading Actor when an import cannot be read', async () => {
      expect(await savedWith({})).toBe(true);
    });
  });

  it('asks nothing of a module that reports nobody, whatever reads Actor', async () => {
    getAdapterManifest.mockReturnValue({ methods: ['getFieldValue'] });
    const listen = await listenOver(offered(), 'm.Actor?.Member == true');
    const arrival = posted();

    expect(await withActors([arrival], { team: TEAM, listens: [listen], adapter: delivered })).toEqual({ arrivals: [arrival], actors: [{ kind: 'unneeded' }] });
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('writes Actor for a fire statement that is not anyone, though no listen reads it', async () => {
    const listen = await listenOver(chatSchema(), 'm.Text == "hi"');
    const automation = randomUUID();
    triggerRows([{ movement_id: automation }]);
    grantsAmong.mockResolvedValue(new Map([[automation, [{ verb: 'fire', grantee: { kind: 'team' } }]]]));

    const { arrivals } = await withActors([posted()], { team: TEAM, listens: [listen], adapter: delivered });

    expect(fieldsOf(arrivals[0])?.[ACTOR]).toMatchObject({ Email: 'ada@x.com', Member: true });
  });

  it('asks nothing for a fire statement that names anyone among others', async () => {
    const listen = await listenOver(chatSchema(), 'm.Text == "hi"');
    const automation = randomUUID();
    triggerRows([{ movement_id: automation }]);
    grantsAmong.mockResolvedValue(new Map([[automation, [{ verb: 'fire', grantee: { kind: 'team' } }, { verb: 'fire', grantee: { kind: 'anyone' } }]]]));

    expect((await withActors([posted()], { team: TEAM, listens: [listen], adapter: delivered })).actors).toEqual([{ kind: 'unneeded' }]);
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('a button press awaited by an automation whose text says Actor carries who pressed it', async () => {
    const press = { ...posted(), edge: 'Presses' };
    waitsOn(['Presses']);

    const { arrivals, actors } = await withActors([press, posted()], { team: TEAM, listens: [], adapter: delivered });

    expect(fieldsOf(arrivals[0])?.[ACTOR]).toMatchObject({ Email: 'ada@x.com', Proven: true, Member: true, User: ADA.id });
    expect(actors.map((actor) => actor.kind)).toEqual(['written', 'unneeded']);
  });

  it('a button press awaited by an automation whose text does not say Actor asks nothing', async () => {
    const press = { ...posted(), edge: 'Presses' };

    expect((await withActors([press], { team: TEAM, listens: [], adapter: delivered })).actors).toEqual([{ kind: 'unneeded' }]);
    expect(resolveAdapter).not.toHaveBeenCalled();
  });

  it('a lookup that fails names Actor unread and decides nothing, so the listen reading it leaves the arrival unjudged', async () => {
    getActorCandidates.mockRejectedValue(new Error('users.info: ratelimited'));
    const reading = await listenOver(offered(), 'm.Actor?.Email == "ada@x.com"');
    const notReading = await listenOver(offered(), 'm.Text == "hi"');

    const { arrivals, actors } = await withActors([posted()], { team: TEAM, listens: [reading, notReading], adapter: delivered });
    const judged = judgeArrivals({ listens: [reading, notReading], delivery: delivered, arrivals, now: new Date() });

    const [arrival] = arrivals;
    expect(arrival !== undefined && !('gone' in arrival) ? arrival.landing.unknown : undefined).toEqual([ACTOR]);
    expect(actors).toEqual([{ kind: 'unknown' }]);
    expect(judged.unjudged.map((u) => u.listen)).toEqual([reading]);
    expect(judged.minted.map((m) => m.listen)).toEqual([notReading]);
  });

  it('removes an Actor a body carried through, keeping only what the platform wrote', async () => {
    getActorCandidates.mockResolvedValue([]);
    const listen = await listenOver(offered(), 'm.Actor?.Email == "ada@x.com"');
    const forged = { ...posted(), actor: undefined, landing: { recordType: 'Message', fields: { text: 'hi', [ACTOR]: { Email: 'ada@x.com', Proven: true } } } };

    const { arrivals, actors } = await withActors([forged], { team: TEAM, listens: [listen], adapter: delivered });

    expect(fieldsOf(arrivals[0])).toEqual({ text: 'hi' });
    expect(actors).toEqual([{ kind: 'nobody' }]);
  });

  it('removes a carried Actor where no listen says the module declared one, under a fire statement that is not anyone', async () => {
    getActorCandidates.mockResolvedValue([]);
    const listen = await listenOver(chatSchema(), 'm.Text == "hi"');
    const automation = randomUUID();
    triggerRows([{ movement_id: automation }]);
    grantsAmong.mockResolvedValue(new Map([[automation, [{ verb: 'fire', grantee: { kind: 'team' } }]]]));
    const forged = { ...posted(), actor: undefined, landing: { recordType: 'Message', fields: { text: 'hi', [ACTOR]: { Email: 'ada@x.com', Proven: true, Member: true } } } };

    const { arrivals, actors } = await withActors([forged], { team: TEAM, listens: [listen], adapter: delivered });

    expect(fieldsOf(arrivals[0])).toEqual({ text: 'hi' });
    expect(actors).toEqual([{ kind: 'nobody' }]);
  });

  it('leaves a landing whose module declares its own Actor as the module sent it, and says so once', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const own = graftActorField({
      adapterType: 'chatlog',
      methods: REPORTS,
      schema: chatSchema(message([TEXT, { fieldId: 'fldActor', displayName: 'Actor', kind: 'string', writable: false, required: false }])),
    });
    const listen = { ...(await listenOver(own, 'm.Text == "hi"')), fieldIds: { Message: { Actor: 'fldActor' } } };
    const automation = randomUUID();
    triggerRows([{ movement_id: automation }]);
    const arrival = { ...posted(), landing: { recordType: 'Message', fields: { text: 'hi', fldActor: 'Grace' } } };

    const answer = await withActors([arrival, arrival], { team: TEAM, listens: [listen], adapter: { adapterType: 'chatlog', credentialsId: null } });

    expect(answer).toEqual({ arrivals: [arrival, arrival], actors: [{ kind: 'module' }, { kind: 'module' }] });
    expect(getActorCandidates).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([line]) => String(line).includes("chatlog: 'Message' has its own"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("does not take another connection's listens as saying the module declared its own Actor", async () => {
    // Read by its text, over a plan whose field ids say nothing of `Actor`.
    const reading = { ...(await listenOver(chatSchema(), 'm.Text == "hi"')), readsActor: true, credentialsId: 'cred-a' };
    const other = { ...(await listenOver(chatSchema(), 'm.Text == "hi"')), credentialsId: 'cred-b', fieldIds: { Message: { Actor: 'fldActor' } } };

    const { actors } = await withActors([posted()], { team: TEAM, listens: [reading, other], adapter: { adapterType: 'chat', credentialsId: 'cred-a' } });

    expect(actors.map((actor) => actor.kind)).toEqual(['written']);
  });

  it('asks once for each person a delivery brings', async () => {
    const listen = await listenOver(offered(), 'm.Actor?.Email == "ada@x.com"');

    const { actors } = await withActors([posted(), { ...posted(), identity: 'm-U1-again' }], { team: TEAM, listens: [listen], adapter: delivered });

    expect(actors.map((actor) => actor.kind)).toEqual(['written', 'written']);
    expect(getActorCandidates).toHaveBeenCalledTimes(1);
    expect(lookupTeamUserByEmail).toHaveBeenCalledTimes(1);
  });

  it('a Run now carries its caller, proven, as the platform signed them in', async () => {
    const invocation = invocationArrival({ firedAt: '2026-11-11T10:00:00Z', submissionId: 's-1', actorEmail: 'Ada@X.com', actorName: 'Ada' });
    getActorCandidates.mockResolvedValue([{ identity: { identifier: 'ada@x.com', scheme: 'email', adapterType: 'manual', email: 'ada@x.com' }, source: 'originator' }]);
    const listen: SavedListen = { ...(await listenOver(offered(), 'm.Text == "hi"')), readsActor: true, fieldIds: { Invocation: { [ACTOR]: ACTOR } } };

    const { arrivals } = await withActors([invocation], { team: TEAM, listens: [listen], adapter: { adapterType: 'manual', credentialsId: null } });

    expect(fieldsOf(arrivals[0])?.[ACTOR]).toEqual({
      Id: 'ada@x.com',
      Email: 'ada@x.com',
      Domain: 'x.com',
      Name: 'Ada',
      Proven: true,
      Member: true,
      User: ADA.id,
    });
  });

  it('a Run now by a machine names nobody', () => {
    expect('actor' in invocationArrival({ firedAt: '2026-11-11T10:00:00Z', submissionId: 's-2' })).toBe(false);
  });
});
