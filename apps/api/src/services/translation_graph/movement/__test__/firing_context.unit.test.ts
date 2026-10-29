// The firing's Context seam (../firing_context.ts).
//
// The bug it exists for: the background workers called straight into a firing
// with no ambient Context, so every service that scopes itself by the acting
// identity threw inside the run. Page fetching is the one that hurt — its
// persistence step reads the team off the Context, the plugin's catch turned
// the throw into a warning, and a scheduled movement fetched nothing at all.

import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line prefer-const
let mockTrigger: { id: string; kind: string; config: unknown; created_by_user_id: string | null } | undefined = {
  id: 'trigger-1',
  kind: 'cron',
  config: {},
  created_by_user_id: 'user-author',
};
// eslint-disable-next-line prefer-const
let mockMembers: Array<{ user_id: string; access: string }> = [
  { user_id: 'user-author', access: 'write' },
];

jest.mock('../../../../lib/kysely', () => {
  const chain = <T>(terminal: string, value: () => T) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['selectFrom', 'select', 'where', 'orderBy']) {
      builder[method] = () => builder;
    }
    builder[terminal] = async () => value();
    return builder;
  };
  return {
    getAutomationsQb: () => chain('executeTakeFirst', () => mockTrigger),
    getCoreQb: () => chain('execute', () => mockMembers),
  };
});

// Who an email's message resolves to — the resolution `@user_*` reads.
// eslint-disable-next-line prefer-const
let mockEmailActor: { id: string; email: string } | null = null;
const mockResolveActingUser = jest.fn(async (input: { getCandidates: () => Promise<unknown[]> }) => {
  await input.getCandidates();
  return mockEmailActor;
});
jest.mock('../../adapters/acting_user/resolve', () => ({
  resolveActingUser: (input: { getCandidates: () => Promise<unknown[]> }) => mockResolveActingUser(input),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { Context, currentContext, unsafeCurrentContext } from '../../../context';
import { withFiringContext } from '../firing_context';
import { userPrincipal } from '../../../principal';

const TEAM = 'team-1' as TeamId;
const event: TriggerEvent = {
  pipelineInputId: 'trigger:trigger-1',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { sender: 'founder@startup.com', subject: 'Our seed round' },
};
const firing = { teamId: TEAM, triggerId: 'trigger-1', event };

beforeEach(() => {
  mockTrigger = { id: 'trigger-1', kind: 'cron', config: {}, created_by_user_id: 'user-author' };
  mockMembers = [{ user_id: 'user-author', access: 'write' }];
  mockEmailActor = null;
  mockResolveActingUser.mockClear();
});

describe('withFiringContext', () => {
  it('gives a firing with no ambient Context one bound to the trigger’s team', async () => {
    // What a plugin's persistence step does: read the acting identity.
    const seen = await withFiringContext(firing, async () => ({
      teamId: currentContext().user.teamId,
      userId: currentContext().user.id,
    }));

    expect(seen).toEqual({ teamId: TEAM, userId: 'user-author' });
  });

  it('leaves an ambient Context alone — a request-driven firing keeps its own', async () => {
    const outer = new Context();
    outer.bindPrincipal(userPrincipal({ userId: 'user-requesting', teamId: 'team-other' }));

    const seen = await outer.runAsync(() =>
      withFiringContext(firing, async () => ({
        same: unsafeCurrentContext() === outer,
        teamId: currentContext().user.teamId,
      })),
    );

    expect(seen).toEqual({ same: true, teamId: 'team-other' });
  });

  it('falls back to a write member when the author has left the team', async () => {
    mockMembers = [
      { user_id: 'user-remaining', access: 'write' },
      { user_id: 'user-later', access: 'write' },
    ];

    const seen = await withFiringContext(firing, async () => currentContext().user.id);

    expect(seen).toBe('user-remaining');
  });

  it('still runs the firing when there is nobody to act as', async () => {
    mockTrigger = { id: 'trigger-1', kind: 'cron', config: {}, created_by_user_id: null };
    mockMembers = [];

    const ran = await withFiringContext(firing, async () => 'ran');

    expect(ran).toBe('ran');
    expect(unsafeCurrentContext()).toBeUndefined();
  });
});

// An email run acts as whoever its message resolves to — the sender on the
// team, or a public inbox's claimant — never as the listener's author unless
// the message resolves to nobody. The same person `@user_*` reports.
describe('an email listener’s firing', () => {
  beforeEach(() => {
    mockTrigger = { id: 'trigger-1', kind: 'email', config: { key: 'deals' }, created_by_user_id: 'user-author' };
    mockMembers = [
      { user_id: 'user-author', access: 'write' },
      { user_id: 'user-claimant', access: 'write' },
    ];
  });

  it('acts as whoever the message resolves to, from the run’s own event', async () => {
    mockEmailActor = { id: 'user-claimant', email: 'claimant@team.com' };

    const seen = await withFiringContext(firing, async () => currentContext().user.id);

    expect(seen).toBe('user-claimant');
    expect(mockResolveActingUser).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM,
        trigger: { id: 'trigger-1', kind: 'email', config: { key: 'deals' }, createdByUserId: 'user-author' },
      }),
    );
  });

  it('holds for a listener stored under a legacy email kind', async () => {
    mockTrigger = { id: 'trigger-1', kind: 'CUSTOM_EMAIL', config: { key: 'deals' }, created_by_user_id: 'user-author' };
    mockEmailActor = { id: 'user-claimant', email: 'claimant@team.com' };

    await expect(withFiringContext(firing, async () => currentContext().user.id)).resolves.toBe('user-claimant');
  });

  it('falls back to the author when the message resolves to nobody', async () => {
    await expect(withFiringContext(firing, async () => currentContext().user.id)).resolves.toBe('user-author');
  });

  it('leaves every other listener as before, without asking the message', async () => {
    mockTrigger = { id: 'trigger-1', kind: 'cron', config: {}, created_by_user_id: 'user-author' };
    mockEmailActor = { id: 'user-claimant', email: 'claimant@team.com' };

    await expect(withFiringContext(firing, async () => currentContext().user.id)).resolves.toBe('user-author');
    expect(mockResolveActingUser).not.toHaveBeenCalled();
  });
});

// Every firing entry point must pass through the seam — that is the whole
// reason it is one place rather than one wrapper per background worker.
describe('execute.ts routes every firing through the seam', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'execute.ts'), 'utf-8');

  it.each([
    ['runMovementFiring', 'runMovementFiringInContext'],
    ['resumeMovementFiring', 'resumeMovementFiringInContext'],
    ['fireCallbackFiring', 'fireCallbackFiringInContext'],
  ])('%s', (_entry, inner) => {
    expect(src).toContain(`withFiringContext(input, () => ${inner}(input))`);
  });
});
