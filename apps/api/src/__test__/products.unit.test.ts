import { PRODUCTS, compose, defaultScopesFor, scopesFor } from '../products';

const CORE_ENV = { LISTEN_FIRE_PRINCIPAL: 'core' };
const STATIC_ENV = { LISTEN_FIRE_PRINCIPAL: 'static' };

describe('compose', () => {
  it('defaults to every product — the composed Listen-Fire deployment', () => {
    for (const raw of [undefined, '', '  ', 'all']) {
      const { products, composed } = compose({ ...CORE_ENV, LISTEN_FIRE_PRODUCTS: raw });
      expect([...products].sort()).toEqual([...PRODUCTS].sort());
      expect(composed).toBe(true);
    }
  });

  it('mounts exactly the named products, whitespace and order notwithstanding', () => {
    const { products, composed } = compose({
      ...CORE_ENV,
      LISTEN_FIRE_PRODUCTS: ' automations , core,valuations ',
    });
    expect([...products].sort()).toEqual(['automations', 'core', 'valuations']);
    expect(composed).toBe(false);
  });

  it('treats an explicit full list as the composed deployment', () => {
    const { composed } = compose({ ...CORE_ENV, LISTEN_FIRE_PRODUCTS: PRODUCTS.join(',') });
    expect(composed).toBe(true);
  });

  it('fails the boot on an unknown product rather than quietly dropping it', () => {
    expect(() => compose({ ...CORE_ENV, LISTEN_FIRE_PRODUCTS: 'core,dealflow' })).toThrow(
      /unknown product\(s\): dealflow/,
    );
    expect(() => compose({ ...CORE_ENV, LISTEN_FIRE_PRODUCTS: 'Core' })).toThrow(/unknown product/);
  });

  it('fails the boot on a list that names nothing', () => {
    expect(() => compose({ ...CORE_ENV, LISTEN_FIRE_PRODUCTS: ',,' })).toThrow(/names no products/);
  });
});

describe('compose — core and the principal must agree', () => {
  it('refuses core identity with no core product to mint credentials', () => {
    expect(() => compose({ ...CORE_ENV, LISTEN_FIRE_PRODUCTS: 'valuations' })).toThrow(
      /LISTEN_FIRE_PRINCIPAL=core needs the `core` product mounted/,
    );
  });

  it('refuses the static stub alongside core', () => {
    expect(() => compose({ ...STATIC_ENV, LISTEN_FIRE_PRODUCTS: 'core,asks' })).toThrow(
      /cannot be combined with the `core` product/,
    );
  });

  it('accepts the standalone shape: one product, static identity', () => {
    const { products, composed } = compose({ ...STATIC_ENV, LISTEN_FIRE_PRODUCTS: 'asks' });
    expect([...products]).toEqual(['asks']);
    expect(composed).toBe(false);
  });

  it('accepts the Tiny shape: core plus two products', () => {
    const { products } = compose({
      ...CORE_ENV,
      LISTEN_FIRE_PRODUCTS: 'core,valuations,automations',
    });
    expect([...products].sort()).toEqual(['automations', 'core', 'valuations']);
  });
});

describe('scopesFor — what an api-key can be granted on an installation', () => {
  const scopesOf = (raw: string, principal = 'core') =>
    scopesFor(compose({ LISTEN_FIRE_PRINCIPAL: principal, LISTEN_FIRE_PRODUCTS: raw }).products);

  it('names every product surface the composed deployment mounts', () => {
    expect(scopesOf('all')).toEqual(['valuations', 'automation', 'knowledge', 'asks', 'secrets', 'system']);
  });

  it('offers `secrets` wherever automations mounts, and never in a default mint', () => {
    expect(scopesOf('core,automations')).toContain('secrets');
    expect(scopesOf('core,valuations')).not.toContain('secrets');
    const composed = compose({ LISTEN_FIRE_PRINCIPAL: 'core', LISTEN_FIRE_PRODUCTS: 'all' }).products;
    expect(defaultScopesFor(composed)).toEqual(['valuations', 'automation', 'knowledge', 'asks', 'system']);
  });

  it('withholds the scope of a product this installation does not run', () => {
    expect(scopesOf('knowledge', 'static')).toEqual(['knowledge', 'system']);
    expect(scopesOf('core,valuations')).toEqual(['valuations', 'system']);
  });

  it('gives every shape the `system` scope — /v1/system is unclaimed by any unit', () => {
    for (const product of PRODUCTS) {
      const principal = product === 'core' ? 'core' : 'static';
      expect(scopesOf(product, principal)).toContain('system');
    }
  });

  it('names nothing core alone gates: core mounts login, not a scoped surface', () => {
    expect(scopesOf('core')).toEqual(['system']);
  });
});
