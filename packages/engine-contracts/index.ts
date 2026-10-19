// The contracts the movement engine speaks, in one package an embedder
// imports without the run host: whose a run is (an opaque tenant id), the
// host's families and what each entry into the engine is handed, a parked
// flow's state, file descriptors, the adapter protocol, and what a module is
// written against: the adapter contract and its manifest, the catalog's schema
// types and positions, the Expression vocabulary, plugins as data and the
// model names. The catalog snapshot a run is handed is the language's
// (`movement-lang`), re-exported here. Runtime-neutral: what only a Node host
// has (a byte stream, the secrets family, the browser slot) is
// `@listen-fire/module-runtime`'s.

export type { AdapterSnapshot, CatalogSnapshot, LanguageVersion } from 'movement-lang';

export * from './adapter';
export * from './awaitable';
export * from './callback';
export * from './catalog';
export * from './cost';
export * from './event';
export * from './expression/expression';
export * from './expression/schemas';
export * from './file_ref';
export * from './guids';
export * from './handbook_section';
export * from './host_families';
export * from './model_names';
export * from './mutation_context';
export * from './park_state';
export * from './plugin_spec';
export * from './position';
export * from './protocol';
export * from './provenance';
export * from './records';
export * from './run_input';
export * from './tenant';
export * from './trigger_config';
export * from './uniqueness';
export * from './versions';
export * from './write_record';

// Two files each name these. The root carries the adapter contract's resource
// filter and the protocol's page schema; the adapter contract's page interface
// is `engine-contracts/adapter`'s, the Expression vocabulary's resource filter
// `engine-contracts/expression/schemas`'.
export type { ResourceFilter } from './adapter';
export { RelatedPage } from './protocol';
