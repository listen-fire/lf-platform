// The in-app "add/edit credential" modal's save path for Gmail
// (addCredential / updateCredential, GOOGLE_GMAIL branch) — the second of the
// three mailbox-allowlist enforcement sites. The connect-LINK form
// (connect_form_spec.ts) already ran `validateGmailMailbox` before storing;
// this locks that the modal now runs the SAME function, so a wrong address or
// an unallowlisted one is refused on the form instead of surfacing later in a
// run.

const validateMock = jest.fn();
jest.mock('../../../../services/access/decide', () => jest.requireActual('../../../../test/access_defaults').teamDefaults());
jest.mock('../../../../adapters/gmail/apiClient', () => {
  const actual = jest.requireActual('../../../../adapters/gmail/apiClient');
  return { ...actual, validateGmailMailbox: (...args: unknown[]) => validateMock(...args) };
});

const persistMock = jest.fn().mockResolvedValue('cred-1');
jest.mock('../../../../services/credentials/persist_credential', () => ({
  persistCredential: (...args: unknown[]) => persistMock(...args),
}));

const ctxUser = { id: 'user-1', teamId: 'team-1' };
// The shared procedure reads the Principal off the Context when nothing
// installed an ambient one (C-10) — a fake Context needs to carry both.
const ctxPrincipal = {
  userId: ctxUser.id,
  teamId: ctxUser.teamId,
  access: 'write' as const,
  scopes: ['*'],
  pinnedTeamId: null,
};
jest.mock('../../../../services/context', () => ({
  currentContext: () => ({ user: ctxUser, principal: ctxPrincipal }),
}));

jest.mock('../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (creds: unknown) => creds,
}));

import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { credentialsRouter } from '../credentials';
import { trpc } from '../../trpc';

function caller() {
  const router = credentialsRouter(trpc.procedure);
  return router.createCaller({ authorise: async () => {} });
}

beforeEach(() => {
  validateMock.mockReset();
  persistMock.mockClear();
});

describe('addCredential — Gmail runs the live check before storing', () => {
  it('refuses without storing when the mailbox is not allowlisted (or otherwise fails the live check)', async () => {
    validateMock.mockResolvedValue({
      ok: false,
      message: 'someone@example.com is not on this installation’s GMAIL_MAILBOX_ALLOWLIST.',
    });

    await expect(
      caller().addCredential({ use: [{ kind: 'team' }],
        name: 'Deals mailbox',
        type: ExternalServiceType.GOOGLE_GMAIL,
        credentials: { mailbox: 'someone@example.com' },
      }),
    ).rejects.toThrow('GMAIL_MAILBOX_ALLOWLIST');

    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({ mailbox: 'someone@example.com' }),
    );
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('stores once the live check passes', async () => {
    validateMock.mockResolvedValue({
      ok: true,
      profile: { emailAddress: 'deals@example.com', historyId: '1' },
    });

    await caller().addCredential({ use: [{ kind: 'team' }],
      name: 'Deals mailbox',
      type: ExternalServiceType.GOOGLE_GMAIL,
      credentials: { mailbox: 'deals@example.com' },
    });

    expect(persistMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ExternalServiceType.GOOGLE_GMAIL,
        credentials: { mailbox: 'deals@example.com' },
      }),
    );
  });
});
