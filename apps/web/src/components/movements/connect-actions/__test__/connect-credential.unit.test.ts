jest.mock('@/lib/trpc', () => ({ trpc: { useUtils: () => ({}) } }));

import type { Grantee } from '@/components/access/grantees';
import { runConnectAction } from '../registry';
import { selectConnectUrlMutation } from '../connect-credential';

describe('selectConnectUrlMutation', () => {
  it('routes ATTIO to attioConnectUrl', () => {
    const mutate = jest.fn();
    const client = {
      views: { credentials: { attioConnectUrl: { mutate } } },
    } as any;
    const getUrl = selectConnectUrlMutation('ATTIO', client);
    expect(getUrl).toBeDefined();
  });

  it('returns undefined for a service with no OAuth flow', () => {
    expect(selectConnectUrlMutation('NOT_A_SERVICE', {} as any)).toBeUndefined();
  });
});

describe('connecting a credential from the editor', () => {
  function client() {
    const slackConnectUrl = { mutate: jest.fn(async () => 'https://slack.test/authorize') };
    const addCredential = { mutate: jest.fn(async () => undefined) };
    return { slackConnectUrl, addCredential, client: { views: { credentials: { slackConnectUrl, addCredential } } } as any };
  }

  it('asks who may use the connection first, and creates nothing when the person declines', async () => {
    const { slackConnectUrl, addCredential, client: c } = client();
    const chooseUse = jest.fn(async () => null);
    await runConnectAction('connect-credential', { adapter: 'slack', serviceType: 'SLACK', client: c, refreshInstance: jest.fn(), chooseUse });
    expect(chooseUse).toHaveBeenCalledTimes(1);
    expect(slackConnectUrl.mutate).not.toHaveBeenCalled();
    expect(addCredential.mutate).not.toHaveBeenCalled();
  });

  it('passes the chosen list to addCredential with the claim, once the person has finished the sign-in', async () => {
    const { addCredential, client: c } = client();
    const channels: { onmessage?: (event: { data: { claimToken: string } }) => void; close: () => void }[] = [];
    class FakeChannel {
      onmessage?: (event: { data: { claimToken: string } }) => void;
      constructor() {
        channels.push(this);
      }
      close() {}
    }
    Object.assign(globalThis, {
      BroadcastChannel: FakeChannel,
      window: {
        open: () => {
          // The popup finishes: the claim arrives on the channel the handler is listening on.
          setTimeout(() => channels[0]?.onmessage?.({ data: { claimToken: 'claim-1' } }), 0);
          return undefined;
        },
      },
    });
    const use: Grantee[] = [{ kind: 'user', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];

    await runConnectAction('connect-credential', {
      adapter: 'slack',
      serviceType: 'SLACK',
      client: c,
      refreshInstance: jest.fn(),
      chooseUse: jest.fn(async () => use),
    });

    expect(addCredential.mutate).toHaveBeenCalledWith({ name: 'slack', type: 'SLACK', claimToken: 'claim-1', use });
  });
});
