// Public inbox claims against the real table: one team per key whatever case
// it is written in, a clash refused by name rather than discovered at
// delivery, and a release only by the team holding the key.

import { randomUUID } from 'node:crypto';

import { getAutomationsQb } from '../../../../../lib/kysely';
import {
  claimPublicInbox,
  findPublicInbox,
  listPublicInboxes,
  releasePublicInbox,
} from '../public_inbox';

const TEAM_A = randomUUID();
const TEAM_B = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();
// Keys are deployment-wide; a run's own suffix keeps reruns apart.
const RUN = randomUUID().slice(0, 8);
const KEY = `deals-${RUN}`;

afterAll(async () => {
  await getAutomationsQb(['public_inbox']).deleteFrom('public_inbox').where('team_id', 'in', [TEAM_A, TEAM_B]).execute();
});

describe('claiming a public inbox', () => {
  it('claims a free key for the team, recording who runs act as', async () => {
    const result = await claimPublicInbox({ teamId: TEAM_A, key: ` ${KEY} `, claimedByUserId: ALICE });

    expect(result).toMatchObject({ status: 'claimed', inbox: { key: KEY, teamId: TEAM_A, claimedByUserId: ALICE } });
    await expect(findPublicInbox(KEY.toUpperCase())).resolves.toMatchObject({ key: KEY, teamId: TEAM_A });
  });

  it('leaves a key the team already holds as it is, claimant included', async () => {
    const result = await claimPublicInbox({ teamId: TEAM_A, key: KEY, claimedByUserId: BOB });

    expect(result).toMatchObject({ status: 'already_claimed', inbox: { claimedByUserId: ALICE } });
  });

  it('refuses a key another team holds, in any case, naming the clash', async () => {
    const result = await claimPublicInbox({ teamId: TEAM_B, key: KEY.toUpperCase(), claimedByUserId: BOB });

    expect(result).toEqual({ status: 'held_by_another_team', key: KEY, teamId: TEAM_A });
    await expect(listPublicInboxes(TEAM_B)).resolves.toEqual([]);
  });

  it('refuses a key that cannot be the part between "+" and "@"', async () => {
    for (const key of ['', 'two words', 'a@b', 'a+b', 'x'.repeat(31)]) {
      await expect(claimPublicInbox({ teamId: TEAM_B, key, claimedByUserId: BOB })).resolves.toMatchObject({
        status: 'invalid_key',
      });
    }
  });

  it('lists only the team’s own', async () => {
    await expect(listPublicInboxes(TEAM_A)).resolves.toEqual([
      expect.objectContaining({ key: KEY, teamId: TEAM_A, claimedByUserId: ALICE }),
    ]);
  });
});

describe('releasing a public inbox', () => {
  it('is refused for a team that does not hold the key', async () => {
    await expect(releasePublicInbox({ teamId: TEAM_B, key: KEY })).resolves.toEqual({
      status: 'held_by_another_team',
      key: KEY,
      teamId: TEAM_A,
    });
    await expect(findPublicInbox(KEY)).resolves.not.toBeNull();
  });

  it('frees the key for the team that holds it, and then for anyone to claim', async () => {
    await expect(releasePublicInbox({ teamId: TEAM_A, key: KEY })).resolves.toEqual({ status: 'released', key: KEY });
    await expect(findPublicInbox(KEY)).resolves.toBeNull();
    await expect(releasePublicInbox({ teamId: TEAM_A, key: KEY })).resolves.toEqual({ status: 'not_claimed', key: KEY });

    await expect(claimPublicInbox({ teamId: TEAM_B, key: KEY, claimedByUserId: BOB })).resolves.toMatchObject({
      status: 'claimed',
      inbox: { teamId: TEAM_B },
    });
  });
});
