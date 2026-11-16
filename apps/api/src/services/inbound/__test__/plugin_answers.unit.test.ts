// The answer cache between the judge and a host function: a question costs a
// call once per team until the team changes or the answer ages out, and
// nothing that a change could have made stale is kept.

import type { PluginQuestion } from 'engine-contracts';
import type { PluginSpec } from 'movement-lang';

import { AdapterBadRequestError } from 'module-kit';

import { askPluginModule, HostFunctionRefused, PluginAnswerCache, type PluginAnswer, type PluginResult } from '../plugin_answers';

const MEMBER: PluginQuestion = { plugin: '@lf-platform/team/is_member', args: ['ada@example.com'] };
const OTHER: PluginQuestion = { plugin: '@lf-platform/team/is_member', args: ['bob@example.com'] };

function cacheWith(options: { maxAgeSeconds?: number | undefined; now?: () => number; ready?: () => Promise<void>; maxKeptPerTeam?: number } = {}) {
  const { maxAgeSeconds, ...rest } = options;
  const age = 'maxAgeSeconds' in options ? maxAgeSeconds : 300;
  return new PluginAnswerCache({ maxAgeSeconds: () => age, ...rest });
}

function counting(answer: PluginAnswer = { value: true }) {
  const asked: PluginQuestion[] = [];
  return {
    asked,
    ask: async (question: PluginQuestion): Promise<PluginAnswer> => {
      asked.push(question);
      return answer;
    },
  };
}

describe('the platform answer cache', () => {
  it('asks a question once for a team, then answers from what it kept', async () => {
    const cache = cacheWith();
    const host = counting();
    const first = await cache.answers('team-1', [MEMBER], host.ask);
    const second = await cache.answers('team-1', [MEMBER], host.ask);
    expect(first).toEqual([{ ...MEMBER, value: true }]);
    expect(second).toEqual(first);
    expect(host.asked).toHaveLength(1);
  });

  it('keeps a team’s answers apart from another team’s', async () => {
    const cache = cacheWith();
    const host = counting();
    await cache.answers('team-1', [MEMBER], host.ask);
    await cache.answers('team-2', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(2);
  });

  it('asks a different argument as a different question', async () => {
    const cache = cacheWith();
    const host = counting();
    await cache.answers('team-1', [MEMBER, OTHER, MEMBER], host.ask);
    expect(host.asked.map((q) => q.args)).toEqual([['ada@example.com'], ['bob@example.com']]);
  });

  it('forgets a team’s answers when its membership changes, and only that team’s', async () => {
    const cache = cacheWith();
    const host = counting();
    await cache.answers('team-1', [MEMBER], host.ask);
    await cache.answers('team-2', [MEMBER], host.ask);
    cache.invalidateTeam('team-1');
    await cache.answers('team-1', [MEMBER], host.ask);
    await cache.answers('team-2', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(3);
  });

  it('forgets every team’s answers when the change feed was lost', async () => {
    const cache = cacheWith();
    const host = counting();
    await cache.answers('team-1', [MEMBER], host.ask);
    await cache.answers('team-2', [MEMBER], host.ask);
    cache.invalidateAll();
    await cache.answers('team-1', [MEMBER], host.ask);
    await cache.answers('team-2', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(4);
  });

  it('asks again once the plugin’s maximum age has passed', async () => {
    let now = 1_000_000;
    const cache = cacheWith({ maxAgeSeconds: 300, now: () => now });
    const host = counting();
    await cache.answers('team-1', [MEMBER], host.ask);
    now += 299_000;
    await cache.answers('team-1', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(1);
    now += 1_000;
    await cache.answers('team-1', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(2);
  });

  it('keeps nothing of a plugin that declares no maximum age', async () => {
    const cache = cacheWith({ maxAgeSeconds: undefined });
    const host = counting();
    await cache.answers('team-1', [MEMBER], host.ask);
    await cache.answers('team-1', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(2);
  });

  it('never keeps an unreachable host', async () => {
    const cache = cacheWith();
    const host = counting({ unreachable: 'the directory is down' });
    expect(await cache.answers('team-1', [MEMBER], host.ask)).toEqual([{ ...MEMBER, unreachable: 'the directory is down' }]);
    await cache.answers('team-1', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(2);
  });

  it('keeps a false answer as well as a true one', async () => {
    const cache = cacheWith();
    const host = counting({ value: false });
    await cache.answers('team-1', [MEMBER], host.ask);
    await cache.answers('team-1', [MEMBER], host.ask);
    expect(host.asked).toHaveLength(1);
  });

  it('asks one question once when several want it at the same time', async () => {
    const cache = cacheWith();
    let release: (answer: PluginAnswer) => void = () => undefined;
    const asked: PluginQuestion[] = [];
    const ask = (question: PluginQuestion) => {
      asked.push(question);
      return new Promise<PluginAnswer>((resolve) => {
        release = resolve;
      });
    };
    const both = Promise.all([cache.answers('team-1', [MEMBER], ask), cache.answers('team-1', [MEMBER], ask)]);
    await new Promise((resolve) => setImmediate(resolve));
    release({ value: true });
    expect(await both).toEqual([[{ ...MEMBER, value: true }], [{ ...MEMBER, value: true }]]);
    expect(asked).toHaveLength(1);
  });

  it('does not keep an answer that was being fetched when its team changed', async () => {
    const cache = cacheWith();
    let release: (answer: PluginAnswer) => void = () => undefined;
    const slow = () =>
      new Promise<PluginAnswer>((resolve) => {
        release = resolve;
      });
    const inFlight = cache.answers('team-1', [MEMBER], slow);
    await new Promise((resolve) => setImmediate(resolve));
    cache.invalidateTeam('team-1');
    release({ value: true });
    await inFlight;
    const host = counting({ value: false });
    expect(await cache.answers('team-1', [MEMBER], host.ask)).toEqual([{ ...MEMBER, value: false }]);
    expect(host.asked).toHaveLength(1);
  });

  it('waits until invalidations will be heard before asking anything', async () => {
    const order: string[] = [];
    const cache = cacheWith({
      ready: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        order.push('listening');
      },
    });
    await cache.answers('team-1', [MEMBER], async () => {
      order.push('asked');
      return { value: true };
    });
    expect(order).toEqual(['listening', 'asked']);
  });

  it('asks nothing when the change feed cannot be reached', async () => {
    const cache = cacheWith({
      ready: async () => {
        throw new Error('no connection');
      },
    });
    const host = counting();
    await expect(cache.answers('team-1', [MEMBER], host.ask)).rejects.toThrow('no connection');
    expect(host.asked).toEqual([]);
  });

  it('asks again after the host threw', async () => {
    const cache = cacheWith();
    let calls = 0;
    const ask = async (): Promise<PluginAnswer> => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { value: true };
    };
    await expect(cache.answers('team-1', [MEMBER], ask)).rejects.toThrow('boom');
    expect(await cache.answers('team-1', [MEMBER], ask)).toEqual([{ ...MEMBER, value: true }]);
  });

  describe('what a team may hold', () => {
    const claim = (n: number): PluginQuestion => ({ plugin: MEMBER.plugin, args: [`sender-${n}@example.com`] });

    it('sweeps the team’s aged answers when a new one is kept', async () => {
      let clock = 0;
      const cache = cacheWith({ now: () => clock, maxAgeSeconds: 10 });
      const host = counting();
      await cache.answers('team-1', [claim(1), claim(2)], host.ask);
      clock = 11_000;
      await cache.answers('team-1', [claim(3)], host.ask);
      expect(cache.keptCount('team-1')).toBe(1);
    });

    it('does not sweep answers that have not aged out', async () => {
      let clock = 0;
      const cache = cacheWith({ now: () => clock, maxAgeSeconds: 10 });
      const host = counting();
      await cache.answers('team-1', [claim(1)], host.ask);
      clock = 5_000;
      await cache.answers('team-1', [claim(2)], host.ask);
      expect(cache.keptCount('team-1')).toBe(2);
    });

    it('caps a team’s answers, dropping the oldest first', async () => {
      let clock = 0;
      const cache = cacheWith({ now: () => clock, maxKeptPerTeam: 3 });
      const host = counting();
      for (let n = 1; n <= 4; n++) {
        clock += 1;
        await cache.answers('team-1', [claim(n)], host.ask);
      }
      expect(cache.keptCount('team-1')).toBe(3);
      host.asked.length = 0;
      await cache.answers('team-1', [claim(4), claim(3), claim(2)], host.ask);
      expect(host.asked).toHaveLength(0);
      await cache.answers('team-1', [claim(1)], host.ask);
      expect(host.asked).toHaveLength(1);
    });

    it('does not let one team’s claims evict another’s', async () => {
      const cache = cacheWith({ maxKeptPerTeam: 2 });
      const host = counting();
      await cache.answers('team-2', [claim(1)], host.ask);
      for (let n = 1; n <= 5; n++) await cache.answers('team-1', [claim(n)], host.ask);
      expect(cache.keptCount('team-2')).toBe(1);
    });
  });
});

// A host function asked in process: its arguments bound to its parameters, its
// answer read as a run reads it and held to what it declares.
describe('asking a plugin module', () => {
  type Spec = Pick<PluginSpec, 'args' | 'output'>;
  const IS_MEMBER_SPEC: Spec = { args: ['claim'], output: { kind: 'value', type: 'boolean' } };
  const USER_FOR_SPEC: Spec = {
    args: ['claim'],
    output: {
      kind: 'record',
      maybeAbsent: true,
      fields: { Id: 'text', Email: { kind: 'branded', of: 'text', brands: ['claim:email/address'] }, Name: 'text', Level: { kind: 'enum', options: ['read', 'write', 'admin'] } },
    },
  };
  const ADA = { Id: 'u-1', Email: 'ada@example.com', Name: 'Ada', Level: 'admin' };

  const asking = (spec: Spec, answer: () => Promise<PluginResult>) => {
    const invoked: unknown[] = [];
    return {
      invoked,
      ask: (args: unknown[]) =>
        askPluginModule({
          plugin: '@lf-platform/team/x',
          args,
          spec,
          invoke: async (config) => {
            invoked.push(config);
            return answer();
          },
        }),
    };
  };

  it('binds the arguments to the declared parameters in order, and reads a value', async () => {
    const module = asking(IS_MEMBER_SPEC, async () => ({ data: { value: true } }));
    expect(await module.ask(['ada@example.com'])).toEqual({ value: true });
    expect(module.invoked).toEqual([{ claim: 'ada@example.com' }]);
  });

  it('reads a record as its data, and none as an answer with no data', async () => {
    expect(await asking(USER_FOR_SPEC, async () => ({ data: ADA })).ask(['ada@example.com'])).toEqual({ value: ADA });
    expect(await asking(USER_FOR_SPEC, async () => ({})).ask(['bob@example.com'])).toEqual({ value: null });
  });

  it.each<[string, Spec, PluginResult]>([
    ['no value', IS_MEMBER_SPEC, { data: {} }],
    ['an undefined value', IS_MEMBER_SPEC, { data: { value: undefined } }],
    ['text for a boolean', IS_MEMBER_SPEC, { data: { value: 'yes' } }],
    ['a record that is not an object', USER_FOR_SPEC, { data: { value: 'nobody' } as unknown as Record<string, unknown> }],
    ['an empty record whose fields are required', USER_FOR_SPEC, { data: {} }],
    ['a level that is none of the levels', USER_FOR_SPEC, { data: { ...ADA, Level: 'owner' } }],
    ['text without data for a record', USER_FOR_SPEC, { text: 'Ada' }],
  ])('refuses %s, never judging by it', async (_what, spec, answer) => {
    await expect(asking(spec, async () => answer).ask(['ada@example.com'])).rejects.toBeInstanceOf(HostFunctionRefused);
  });

  it('refuses for the module what it refuses itself, and what is not its declared answer', async () => {
    await expect(asking(IS_MEMBER_SPEC, async () => Promise.reject(new AdapterBadRequestError('a claim is text'))).ask([42])).rejects.toThrow(
      new HostFunctionRefused('@lf-platform/team/x', 'a claim is text'),
    );
    await expect(asking(IS_MEMBER_SPEC, async () => ({ data: { value: true } })).ask(['a', 'b'])).rejects.toBeInstanceOf(HostFunctionRefused);
  });

  it('reads any other failure as a module out of reach: its arrival waits', async () => {
    const answer = await asking(IS_MEMBER_SPEC, async () => Promise.reject(new Error('Connection terminated unexpectedly'))).ask(['ada@example.com']);
    expect(answer).toEqual({ unreachable: expect.stringContaining('Connection terminated unexpectedly') });
  });
});
