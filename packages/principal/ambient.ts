// One AsyncLocalStorage, process-wide (C-1). Shipping the store here rather
// than leaving products to each construct their own is the point: a composed
// deployment with four stores has four half-populated identities and no way to
// tell which one a call site read.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Principal } from './principal';

const store = new AsyncLocalStorage<Principal>();

/** Run `fn` with `p` as the ambient principal for every continuation it spawns. */
function runWithPrincipal<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
  return store.run(p, fn);
}

/**
 * The sync-callback form, for adapters that hand control to a framework rather
 * than awaiting (express's `next()`). Kept separate from `runWithPrincipal` so
 * a rejected continuation cannot escape as an unhandled rejection: whatever the
 * framework does with the error, it does it inside the context.
 */
function runWithPrincipalSync<T>(p: Principal, fn: () => T): T {
  return store.run(p, fn);
}

/**
 * Run `fn` with NO ambient principal, whatever the caller has in scope. Every
 * continuation `fn` spawns (a timer, a promise) starts empty too. For work
 * that must not act as whoever happened to schedule it.
 */
function runWithoutPrincipal<T>(fn: () => T): T {
  return store.exit(fn);
}

/** The ambient principal. Throws when there is none — an unauthenticated call
 *  site reaching for identity is a bug, not a `read` principal. */
function currentPrincipal(): Principal {
  const principal = store.getStore();
  if (principal === undefined) {
    throw new Error('No ambient principal: this code path must run inside runWithPrincipal().');
  }
  return principal;
}

/** For the call sites that legitimately run both inside and outside a request
 *  (workers, logging, metering). */
function maybePrincipal(): Principal | undefined {
  return store.getStore();
}

/**
 * The acting USER's id — for the paths that record attribution and therefore
 * genuinely require a person, not just a tenant. Machine principals (inbound
 * webhooks, schedulers) have no `userId`, and a path that needs one is asking
 * a question they cannot answer; this says so rather than writing `undefined`
 * into an author column.
 */
function currentUserId(): string {
  const { userId } = currentPrincipal();
  if (userId === undefined) {
    throw new Error('This code path acts on behalf of a user, but the principal is a machine.');
  }
  return userId;
}

export {
  runWithPrincipal,
  runWithPrincipalSync,
  runWithoutPrincipal,
  currentPrincipal,
  maybePrincipal,
  currentUserId,
};
