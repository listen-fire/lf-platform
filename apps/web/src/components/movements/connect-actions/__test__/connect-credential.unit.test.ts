jest.mock('@/lib/trpc', () => ({ trpc: { useUtils: () => ({}) } }));

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
});
