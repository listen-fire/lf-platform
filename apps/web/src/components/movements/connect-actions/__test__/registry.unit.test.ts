// The app-shipped connect-action handler registry: registration + dispatch
// by `kind`. The framework routes a manifest-declared `kind` here; an unknown
// kind is inert (the editor leaves the entry doing nothing rather than
// crashing).

// `registry.ts` imports `@/lib/trpc` only for a type (`ReturnType<typeof
// trpc.useUtils>`), which is erased at runtime — but ts-jest still loads the
// module, which pulls the tRPC react client chain. Stub it: the registry
// never touches `trpc` at runtime.
jest.mock('@/lib/trpc', () => ({ trpc: { useUtils: () => ({}) } }));

import {
  registerConnectActionHandler,
  runConnectAction,
  hasConnectActionHandler,
  type ConnectActionContext,
} from '../registry';

function fakeCtx(over: Partial<ConnectActionContext> = {}): ConnectActionContext {
  return {
    adapter: 'google_sheets',
    credential: 'my_google',
    // The handler under test never touches these in these cases.
    client: {} as ConnectActionContext['client'],
    refreshInstance: jest.fn(),
    chooseUse: jest.fn(async () => null),
    ...over,
  };
}

describe('connect-action registry', () => {
  it('dispatches to the registered handler by kind, passing the instance context', async () => {
    const handler = jest.fn(async () => {});
    registerConnectActionHandler('test-kind', handler);

    const ctx = fakeCtx();
    const ran = await runConnectAction('test-kind', ctx);

    expect(ran).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx);
  });

  it('reports whether a kind has a handler', () => {
    registerConnectActionHandler('known-kind', async () => {});
    expect(hasConnectActionHandler('known-kind')).toBe(true);
    expect(hasConnectActionHandler('unheard-of')).toBe(false);
  });

  it('is inert (returns false, never throws) for an unknown kind', async () => {
    await expect(runConnectAction('no-such-kind', fakeCtx())).resolves.toBe(false);
  });

  it('the google-drive-picker handler self-registers on import of the index', async () => {
    await import('../index');
    expect(hasConnectActionHandler('google-drive-picker')).toBe(true);
  });
});
