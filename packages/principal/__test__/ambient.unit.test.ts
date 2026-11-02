import {
  currentPrincipal,
  maybePrincipal,
  runWithPrincipal,
  runWithPrincipalSync,
  runWithoutPrincipal,
} from '../ambient';
import type { Principal } from '../principal';

function principal(teamId: string, userId?: string): Principal {
  return { teamId, userId, access: 'write', scopes: ['*'], pinnedTeamId: teamId };
}

describe('the ambient principal store', () => {
  it('has no principal outside a run', () => {
    expect(maybePrincipal()).toBeUndefined();
    expect(() => currentPrincipal()).toThrow(/No ambient principal/);
  });

  it('exposes the principal to every continuation inside the run', async () => {
    await runWithPrincipal(principal('team-a', 'user-a'), async () => {
      expect(currentPrincipal().teamId).toBe('team-a');
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentPrincipal().userId).toBe('user-a');
      await Promise.all([
        (async () => expect(currentPrincipal().teamId).toBe('team-a'))(),
        (async () => expect(maybePrincipal()?.teamId).toBe('team-a'))(),
      ]);
    });
  });

  it('keeps interleaved async contexts isolated', async () => {
    const seen: string[] = [];

    const request = (teamId: string, delayMs: number) =>
      runWithPrincipal(principal(teamId), async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(`${teamId}:${currentPrincipal().teamId}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return currentPrincipal().teamId;
      });

    const [a, b, c] = await Promise.all([
      request('team-a', 8),
      request('team-b', 2),
      request('team-c', 5),
    ]);

    expect([a, b, c]).toEqual(['team-a', 'team-b', 'team-c']);
    expect(seen.sort()).toEqual(['team-a:team-a', 'team-b:team-b', 'team-c:team-c']);
  });

  it('restores the outer principal after a nested run', async () => {
    await runWithPrincipal(principal('outer'), async () => {
      await runWithPrincipal(principal('inner'), async () => {
        expect(currentPrincipal().teamId).toBe('inner');
      });
      expect(currentPrincipal().teamId).toBe('outer');
    });
    expect(maybePrincipal()).toBeUndefined();
  });

  it('installs the principal for a synchronous callback and its continuations', async () => {
    const later = runWithPrincipalSync(principal('team-sync'), () => {
      expect(currentPrincipal().teamId).toBe('team-sync');
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentPrincipal().teamId;
      })();
    });

    expect(maybePrincipal()).toBeUndefined();
    await expect(later).resolves.toBe('team-sync');
  });

  it('runs a callback, and every timer it schedules, with no principal at all', async () => {
    const later = await runWithPrincipal(principal('team-kicker'), async () =>
      runWithoutPrincipal(() => {
        expect(maybePrincipal()).toBeUndefined();
        return new Promise<string | undefined>((resolve) => {
          setTimeout(() => resolve(maybePrincipal()?.teamId), 1);
        });
      }),
    );

    expect(later).toBeUndefined();
  });
});
