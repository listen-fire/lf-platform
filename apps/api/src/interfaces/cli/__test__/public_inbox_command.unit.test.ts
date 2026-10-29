// The operator's `public-inbox` command: it claims for a named member of the
// team (the CLI is nobody on the team itself), names the team holding a key
// it cannot claim, and lists or releases the team's own.

const claimPublicInbox = jest.fn();
const releasePublicInbox = jest.fn();
const listPublicInboxes = jest.fn();
const userByEmail = jest.fn();

jest.mock('../../../lib/kysely', () => ({ globalQb: { destroy: async () => undefined } }));

jest.mock('../../../services/principal', () => ({
  principalDirectory: () => ({ userByEmail: (q: unknown) => userByEmail(q) }),
}));

jest.mock('../../../services/translation_graph/adapters/email/public_inbox', () => ({
  claimPublicInbox: (input: unknown) => claimPublicInbox(input),
  releasePublicInbox: (input: unknown) => releasePublicInbox(input),
  listPublicInboxes: (teamId: string) => listPublicInboxes(teamId),
}));

import PublicInboxCommand from '../commands/public-inbox';

const INBOX = {
  key: 'deals',
  teamId: 'team-1',
  claimedByUserId: 'user-1',
  createdAt: new Date(0),
  address: 'inbox+deals@example.com',
};

let printed: string[];

function run(options: { team: string; claim?: string; release?: string; by?: string }): Promise<void> {
  // clime hands `execute` a parsed options object; the command reads only its fields.
  return new PublicInboxCommand().execute(options as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  printed = [];
  jest.spyOn(console, 'warn').mockImplementation((line: string) => {
    printed.push(line);
  });
});

describe('the public-inbox command', () => {
  it('claims for the member named by --by', async () => {
    userByEmail.mockResolvedValue({ id: 'user-1', hasAccess: true });
    claimPublicInbox.mockResolvedValue({ status: 'claimed', inbox: INBOX });

    await run({ team: 'team-1', claim: 'deals', by: 'ada@example.com' });

    expect(userByEmail).toHaveBeenCalledWith({ email: 'ada@example.com', teamId: 'team-1' });
    expect(claimPublicInbox).toHaveBeenCalledWith({ teamId: 'team-1', key: 'deals', claimedByUserId: 'user-1' });
    expect(printed.join('\n')).toMatch(/claimed public inbox\n {2}deals \(inbox\+deals@example.com\)/);
  });

  it('will not claim without someone on the team to act as', async () => {
    await expect(run({ team: 'team-1', claim: 'deals' })).rejects.toThrow(/--by/);

    userByEmail.mockResolvedValue({ id: 'user-9', hasAccess: false });
    await expect(run({ team: 'team-1', claim: 'deals', by: 'gone@example.com' })).rejects.toThrow(/not a member/);
    expect(claimPublicInbox).not.toHaveBeenCalled();
  });

  it('names the team holding a key it cannot claim', async () => {
    userByEmail.mockResolvedValue({ id: 'user-1', hasAccess: true });
    claimPublicInbox.mockResolvedValue({ status: 'held_by_another_team', key: 'deals', teamId: 'team-2' });

    await expect(run({ team: 'team-1', claim: 'deals', by: 'ada@example.com' })).rejects.toThrow(
      /"deals" is already a public inbox of team team-2/,
    );
  });

  it('releases only for the team holding the key', async () => {
    releasePublicInbox.mockResolvedValue({ status: 'held_by_another_team', key: 'deals', teamId: 'team-2' });
    await expect(run({ team: 'team-1', release: 'deals' })).rejects.toThrow(/only that team can release it/);

    releasePublicInbox.mockResolvedValue({ status: 'released', key: 'deals' });
    await run({ team: 'team-2', release: 'deals' });
    expect(printed.join('\n')).toMatch(/released public inbox "deals"/);
  });

  it('lists the team’s public inboxes when asked for no change', async () => {
    listPublicInboxes.mockResolvedValue([INBOX]);

    await run({ team: 'team-1' });

    expect(printed.join('\n')).toMatch(/1 public inbox\(es\)\n {2}deals/);
  });
});
