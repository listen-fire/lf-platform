// Which products this process runs.
//
// D30(d): "valuations + automations only" is a supported shape, not a fork —
// one entrypoint, one env var, and everything a product owns (its routers, its
// MCP connector, its REST surface, its workers) mounts together or not at all.
// Nothing downstream branches on the environment; it asks this module.

import { principalMode } from './services/principal/mode';

/** The four products plus the thin identity unit (D2). */
const PRODUCTS = ['core', 'valuations', 'automations', 'knowledge', 'asks'] as const;

type Product = (typeof PRODUCTS)[number];

/**
 * Everything that belongs to no product: billing, wallet, Stripe, ops sweeps
 * and the journey instrumentation. D8 keeps it out of every export and D36
 * leaves it in `public` — so it is not selectable, it simply rides along with
 * the composed Listen-Fire deployment and with nothing else.
 */
type Unit = Product | 'residual';

type Env = Record<string, string | undefined>;

function isProduct(value: string): value is Product {
  return (PRODUCTS as readonly string[]).includes(value);
}

/**
 * Parse `LISTEN_FIRE_PRODUCTS`. Unset (or `all`) is the composed deployment — every
 * product — which is what the hosted Listen-Fire runs and what the branch must keep
 * behaving like. Anything unrecognised is a boot failure: a typo that quietly
 * drops a product would take its workers and its inbound doors down with it,
 * and a silently half-mounted deployment is the absence of a guarantee.
 */
function parseProducts(env: Env): ReadonlySet<Product> {
  const raw = env.LISTEN_FIRE_PRODUCTS;
  if (raw === undefined || raw.trim() === '' || raw.trim() === 'all') return new Set(PRODUCTS);

  const named = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  if (named.length === 0) {
    throw new Error(`LISTEN_FIRE_PRODUCTS names no products. Valid names: ${PRODUCTS.join(', ')}.`);
  }

  const unknown = named.filter((name) => !isProduct(name));
  if (unknown.length > 0) {
    throw new Error(
      `LISTEN_FIRE_PRODUCTS names unknown product(s): ${unknown.join(', ')}. ` +
        `Valid names: ${PRODUCTS.join(', ')} (or "all").`,
    );
  }

  return new Set(named.filter(isProduct));
}

/**
 * `core` and the identity provider are one decision wearing two hats, so they
 * are checked against each other rather than left to drift: core's login
 * routes exist to mint the sessions `LISTEN_FIRE_PRINCIPAL=core` validates, and the
 * static stub accepts none of them. Either half without the other is a
 * deployment that cannot authenticate anybody, which must fail at boot rather
 * than at the first request.
 */
function assertPrincipalAgrees(products: ReadonlySet<Product>, env: Env) {
  const mode = principalMode(env);
  const mountsCore = products.has('core');

  if (mode === 'core' && !mountsCore) {
    throw new Error(
      'LISTEN_FIRE_PRINCIPAL=core needs the `core` product mounted (it serves the login and ' +
        'api-key routes that mint the credentials core validates). Either add `core` to ' +
        'LISTEN_FIRE_PRODUCTS or run the single-tenant stub with LISTEN_FIRE_PRINCIPAL=static.',
    );
  }
  if (mode === 'static' && mountsCore) {
    throw new Error(
      'LISTEN_FIRE_PRINCIPAL=static cannot be combined with the `core` product: core\'s login ' +
        'routes mint sessions the static stub will never accept. Drop `core` from ' +
        'LISTEN_FIRE_PRODUCTS, or set LISTEN_FIRE_PRINCIPAL=core.',
    );
  }
}

/**
 * The api-key scope each product's REST surface gates on (`requireScope` in
 * `interfaces/rest/v1`). `null` is a product that gates nothing of its own:
 * core mounts login and impersonation, neither of which an api-key scope
 * names. Written as a total Record so adding a product to `PRODUCTS` fails to
 * compile until its scope is decided — a product whose scope is forgotten
 * mints keys that cannot reach it, which is the bug this table exists for.
 */
const SCOPE_BY_PRODUCT: Record<Product, string | null> = {
  core: null,
  valuations: 'valuations',
  automations: 'automation',
  knowledge: 'knowledge',
  asks: 'asks',
};

/**
 * Scopes a product's surfaces gate on that a key carries only when its minter
 * asks for them by name. `secrets` opens lf's secrets door
 * (`/api/public/lf-secrets`), which decrypts the team's credentials: a key
 * minted for "this installation" must not do that by default.
 */
const OPT_IN_SCOPES_BY_PRODUCT: Record<Product, readonly string[]> = {
  core: [],
  valuations: [],
  automations: ['secrets'],
  knowledge: [],
  asks: [],
};

/** Scopes that exist on EVERY installation. `/v1/system` is unclaimed by any
 *  unit, so it mounts whatever the product list says. */
const UBIQUITOUS_SCOPES = ['system'] as const;

/** The scope of each mounted product that gates one. */
function productScopes(products: ReadonlySet<Product>): string[] {
  return PRODUCTS.filter((product) => products.has(product))
    .map((product) => SCOPE_BY_PRODUCT[product])
    .filter((scope): scope is string => scope !== null);
}

/** The scopes a key minted with no scope list of its own carries on an
 *  installation running `products`: every product scope, no opt-in one. */
function defaultScopesFor(products: ReadonlySet<Product>): string[] {
  return [...productScopes(products), ...UBIQUITOUS_SCOPES];
}

/** The scopes a key CAN be granted on an installation running `products` —
 *  every scope its surfaces gate on, and nothing that would name a surface
 *  this install does not mount. */
function scopesFor(products: ReadonlySet<Product>): string[] {
  const optIn = PRODUCTS.filter((product) => products.has(product)).flatMap((product) => OPT_IN_SCOPES_BY_PRODUCT[product]);
  return [...productScopes(products), ...optIn, ...UBIQUITOUS_SCOPES];
}

interface Composition {
  products: ReadonlySet<Product>;
  /** True only when every product is mounted — the composed Listen-Fire deployment. */
  composed: boolean;
}

let composition: Composition | undefined;

function compose(env: Env): Composition {
  const products = parseProducts(env);
  assertPrincipalAgrees(products, env);
  return { products, composed: PRODUCTS.every((product) => products.has(product)) };
}

/** Lazily resolved, then frozen: the product set is a boot-time fact. */
function currentComposition(env: Env = process.env): Composition {
  composition ??= compose(env);
  return composition;
}

/** Does this process run `unit`? The residual rides with the composed deployment only. */
function mounts(unit: Unit, env: Env = process.env): boolean {
  const { products, composed } = currentComposition(env);
  return unit === 'residual' ? composed : products.has(unit);
}

/** The mounted products, in declaration order — for boot logging and /healthz. */
function mountedProducts(env: Env = process.env): Product[] {
  const { products } = currentComposition(env);
  return PRODUCTS.filter((product) => products.has(product));
}

/** What a key minted with no scope list of its own is granted on THIS
 *  installation: every product's scope, never an opt-in one. */
function installedScopes(env: Env = process.env): string[] {
  return defaultScopesFor(currentComposition(env).products);
}

export {
  PRODUCTS,
  type Product,
  type Unit,
  type Composition,
  compose,
  mounts,
  mountedProducts,
  scopesFor,
  defaultScopesFor,
  installedScopes,
};
