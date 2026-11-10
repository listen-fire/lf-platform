// One database transaction around work that must commit or roll back whole:
// a thing and what is stated about who may reach it, say. A request is not in
// a transaction on this platform (the transaction handler is mounted after
// every router), so a caller that needs one opens it here.

import { Context, unsafeCurrentContext } from './index';

/**
 * Run `fn` in one database transaction: the caller's open one, else one of
 * its own that commits when `fn` returns and rolls back when it throws.
 */
export async function inOneTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (unsafeCurrentContext()?.kyselyTrx !== undefined) return fn();
  const context = new Context();
  return context.runAsync(async () => {
    await context.enterTransaction();
    return fn();
  });
}
