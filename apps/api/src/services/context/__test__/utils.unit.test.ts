import type { Access } from 'principal';

import { Context, currentContext } from '..';
import { runInSystemContext } from '../utils';

/**
 * runInSystemContext is the seam that protects background/inline callers with
 * no acting user (a background worker + its inline
 * movement-engine callers) from the `currentContext()` throw ("Async local
 * storage undefined") that ModelService-backed services (e.g.
 * MagicLinkTokenService) hit outside any AsyncLocalStorage context.
 */
describe('runInSystemContext', () => {
  it('establishes an ambient context so currentContext() does not throw', async () => {
    expect(() => currentContext()).toThrow('Async local storage undefined');

    await runInSystemContext(async () => {
      expect(() => currentContext()).not.toThrow();
    });
  });

  it('gets the WRITABLE pool despite having no identity to derive it from', async () => {
    // The thing this seam has to keep getting right. It writes — notice
    // markers, magic-link tokens, the outbound-email ledger — and the pool is
    // otherwise chosen from the Principal, of which there is none here. It used
    // to arrive as a side effect of the public ability carrying MANAGE rules,
    // which is exactly the sort of accident deleting that layer was meant to
    // stop relying on; `systemWritable` says it outright now.
    await runInSystemContext(async () => {
      expect(currentContext().isReadonlyPrisma).toBe(false);
    });
  });

  it('returns the wrapped function’s result', async () => {
    const result = await runInSystemContext(async () => 42);
    expect(result).toBe(42);
  });

  it('is safe to nest inside an already-running context', async () => {
    await runInSystemContext(async () => {
      const outer = currentContext();
      await runInSystemContext(async () => {
        expect(currentContext()).not.toBe(outer);
      });
      // the outer context is restored once the nested one exits
      expect(currentContext()).toBe(outer);
    });
  });
});

describe('the pool a principal is given', () => {
  const as = (access: Access) => {
    const ctx = new Context();
    ctx.bindPrincipal({ teamId: 'team', userId: 'user', access, scopes: ['*'], pinnedTeamId: null });
    return ctx.isReadonlyPrisma;
  };

  it('is the writable one for a write member and an admin, and the readonly one for a read member', () => {
    expect(as('admin')).toBe(false);
    expect(as('write')).toBe(false);
    expect(as('read')).toBe(true);
  });
});
