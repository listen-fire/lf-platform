// The `@lf/ask` module over the platform's asks table, against a REAL DB.
//
//   open → answered   a second answer loses as `closed`
//   open → expired    the explicit cancel; answering an expired ask loses too
//
// Plus what the table adds to the module's lattice: the guard that refuses a
// settle another door beat, the wake a settle queues (and the one a refused
// settle does not), and asks raised before ask was a module — the same rows,
// answered and awaited exactly as before.

import { randomBytes, randomUUID } from 'node:crypto';

const enqueueAwaitWakeMock = jest.fn();
const notifyWorkMock = jest.fn();
jest.mock('../../movement_engine/await_wake', () => ({
  ...jest.requireActual('../../movement_engine/await_wake'),
  enqueueAwaitWake: (...a: unknown[]) => enqueueAwaitWakeMock(...a),
}));
jest.mock('../../work/drain', () => ({
  ...jest.requireActual('../../work/drain'),
  notifyWork: () => notifyWorkMock(),
}));

import type { TeamId } from '../../../generated/kysely/core/Team';

import { ASK_TOKEN_PREFIX, answerAsk, cancelAsk } from '@listen-fire/ask';
import { makeStablePosition } from 'movement-engine/public/catalog';
import { getAsksQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { resolveAdapter } from '../../translation_graph/adapters/resolve';
import { answerAskByToken, cancelAskAndWake, createAsk } from '../doors';
import { notifyEngineOfSettledAsks } from '../in_process_notifier';
import { resetAskSettledNotifierForTests } from '../notifier';
import { askTableKv, getAsk, lookupAskByToken, platformAskRecords } from '../store';

describe('the asks table as the ask module\'s kv (real DB)', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetAskSettledNotifierForTests();
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `ask-table-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    resetAskSettledNotifierForTests();
    await cleanupTeam(teamId);
  });

  it('createAsk mints an ask_-prefixed token resolvable by the link surface', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?', callbackUrl: 'https://creator.test/hook' });
    expect(ask.state).toBe('open');
    expect(ask.token.startsWith(ASK_TOKEN_PREFIX)).toBe(true);
    expect(ask.url).toContain(`/api/asks/${ask.token}`);
    expect(ask.callbackUrl).toBe('https://creator.test/hook');

    const byToken = await lookupAskByToken(ask.token);
    expect(byToken?.id).toBe(ask.id);
    expect(await lookupAskByToken('legacy-token')).toBeNull();
  });

  it('every write creates — no dedupe surface', async () => {
    const a = await createAsk({ teamId, family: 'Check', prompt: 'same' });
    const b = await createAsk({ teamId, family: 'Check', prompt: 'same' });
    expect(a.id).not.toBe(b.id);
  });

  it('open → answered stores the typed answer; a second answer loses as closed', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    const records = platformAskRecords(teamId);

    const first = await answerAsk(records, { id: ask.id, raw: 'true' });
    expect(first).toMatchObject({ kind: 'settled', ask: { state: 'answered', answer: true } });

    const second = await answerAsk(records, { id: ask.id, raw: 'false' });
    expect(second).toMatchObject({ kind: 'closed' });

    const persisted = await getAsk(ask.id);
    expect(persisted?.state).toBe('answered');
    expect(persisted?.answer).toBe(true);
    expect(persisted?.answeredAt).not.toBeNull();
  });

  it('open → expired via cancel; answering an expired ask loses as closed', async () => {
    const ask = await createAsk({ teamId, family: 'Provide', prompt: 'How much?', answerType: 'number' });
    const records = platformAskRecords(teamId);

    expect(await cancelAsk(records, { id: ask.id })).toMatchObject({ kind: 'settled', ask: { state: 'expired' } });
    expect((await getAsk(ask.id))?.expiredAt).not.toBeNull();
    expect(await answerAsk(records, { id: ask.id, raw: '42' })).toMatchObject({ kind: 'closed' });
  });

  it('an invalid answer is rejected and leaves the ask open', async () => {
    const ask = await createAsk({ teamId, family: 'Choose', prompt: 'Which?', options: ['a', 'b'] });
    const records = platformAskRecords(teamId);
    expect(await answerAsk(records, { id: ask.id, raw: 'z' })).toMatchObject({ kind: 'invalid' });
    expect((await getAsk(ask.id))?.state).toBe('open');
    expect(await answerAsk(records, { id: ask.id, raw: 'b' })).toMatchObject({ kind: 'settled', ask: { answer: 'b' } });
  });

  it('refuses a settle another door beat: the guard holds, and the first answer stands', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    const kv = askTableKv(teamId);
    const open = await kv.get(`ask:${ask.id}`);
    await answerAskByToken(ask.token, false);
    // A writer that read `open` before that answer landed.
    await expect(
      kv.set(`ask:${ask.id}`, { ...(open as object), state: 'answered', answer: true, answeredAt: new Date().toISOString() }),
    ).rejects.toThrow(/already settled/);
    expect((await getAsk(ask.id))?.answer).toBe(false);
  });

  it('keeps one team\'s asks out of another team\'s kv', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    const other = askTableKv(randomUUID() as TeamId);
    expect(await other.get(`ask:${ask.id}`)).toBeUndefined();
    expect(await other.get(`token:${ask.token}`)).toBeUndefined();
  });

  describe('the wake a settle queues', () => {
    it('with the engine notifier registered, a cancel queues one wake for the ask and kicks the drain', async () => {
      notifyEngineOfSettledAsks();
      const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
      expect(await cancelAskAndWake({ id: ask.id })).toMatchObject({ ok: true });
      expect(enqueueAwaitWakeMock).toHaveBeenCalledTimes(1);
      expect(enqueueAwaitWakeMock).toHaveBeenCalledWith({ adapterType: 'ask', teamId, correlationKey: ask.id });
      expect(notifyWorkMock).toHaveBeenCalledTimes(1);
    });

    it('with nothing registered (asks-only), a cancel queues no wake', async () => {
      const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
      expect(await cancelAskAndWake({ id: ask.id })).toMatchObject({ ok: true });
      expect(enqueueAwaitWakeMock).not.toHaveBeenCalled();
      expect(notifyWorkMock).not.toHaveBeenCalled();
    });

    it('a refused cancel (already settled) wakes nothing', async () => {
      const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
      await answerAskByToken(ask.token, true);
      notifyEngineOfSettledAsks();
      expect(await cancelAskAndWake({ id: ask.id })).toMatchObject({ ok: false, reason: 'settled' });
      expect(enqueueAwaitWakeMock).not.toHaveBeenCalled();
    });

    it('a Response written in movement code wakes like any other door', async () => {
      notifyEngineOfSettledAsks();
      const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
      const adapter = await resolveAdapter({ adapterType: 'ask', teamId });
      await adapter.createRecord({
        recordType: 'Check Response',
        fields: { Answer: true },
        parentLinks: [{ recordType: 'Check', externalId: ask.id, edgeName: 'Response' }],
        mutationContext: { source: { type: 'agent' }, occurredAt: new Date().toISOString() },
      });
      expect(enqueueAwaitWakeMock).toHaveBeenCalledWith({ adapterType: 'ask', teamId, correlationKey: ask.id });
    });
  });

  it('an ask raised before ask was a module answers, wakes and resolves as before', async () => {
    notifyEngineOfSettledAsks();
    // The row exactly as the built-in ask store wrote it: the table mints the
    // id and the token is the old store's shape. A run parked on it holds only
    // the ask's id (its correlation key), which is all the wake and the
    // re-entered await read.
    const token = ASK_TOKEN_PREFIX + randomBytes(24).toString('base64url');
    const row = await getAsksQb(['ask'])
      .insertInto('ask')
      .values({
        team_id: teamId,
        family: 'Choose',
        prompt: 'Which fund?',
        options: JSON.stringify(['Fund I', 'Fund II']) as never,
        token,
        token_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        provenance: JSON.stringify({ movementId: 'mv-old', nodeId: 'node-old' }) as never,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const adapter = await resolveAdapter({ adapterType: 'ask', teamId });
    const point = { recordId: row.id, edge: 'Response' };
    expect(await adapter.awaitable!.resolveAwait(point)).toEqual({ status: 'pending', correlationKey: row.id });
    expect(await adapter.getFieldValue({
      position: makeStablePosition({ adapterType: 'ask', recordType: 'Choose', recordId: row.id }),
      fieldId: 'Url',
    })).toContain(`/api/asks/${token}`);

    const outcome = await answerAskByToken(token, 'Fund II');
    expect(outcome).toMatchObject({ kind: 'answered', ask: { id: row.id, answer: 'Fund II' } });
    expect(enqueueAwaitWakeMock).toHaveBeenCalledWith({ adapterType: 'ask', teamId, correlationKey: row.id });
    expect(await adapter.awaitable!.resolveAwait(point)).toEqual({
      status: 'landed',
      correlationKey: row.id,
      landings: [{ recordId: row.id, recordType: 'Choose Response', fields: { Answer: 'Fund II' } }],
    });
  });
});
