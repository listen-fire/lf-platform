// The TypeScript parser, checker, editor service and story. They read the
// legacy ids 1 to 4. The editor service and the story present only those; '5',
// this copy's dialect of the 0.12 surface, is the checker's upgrade target
// alone, never a stored pin and never presented. A release's semver is refused
// (version_conditionals.ts). The names the language
// package keeps (the catalog and schema types, the diagnostic, the snapshot,
// the wasm bindings) are imported from
// `movement-lang`, not from here.
// The parse entry points, each routed to the parser for its version (the
// language release's own, or the one frozen for the versions it dropped).
export { parseProgram, parseNestedCall } from './parser/parse';
export { parseExpression } from './parser/expression/parse_expression';
export {
  authoredStringText,
  conditionOfSlot,
  expressionOfSlot,
  parseMovementCondition,
  parseMovementExpression,
  treeOfSlot,
} from './expression/bridge';
export { initFrozenParser } from './wasm/frozen_parser';
export * from './parser/duration';
export * from './expression/stdlib';
export * from './checker/catalog';
export * from './checker/scopes';
export * from './checker/meta';
export * from './checker/generics';
export * from './checker/effects';
export * from './checker/standard_library';
export * from './checker/calls';
export * from './checker/nested_calls';
export * from './checker/typing';
export * from './checker/conformance';
export * from './checker/event_address';
export * from './checker/link';
export * from './checker/check';
export * from './checker/upgrade';
export * from './checker/collection_config';
export * from './checker/extract_config';
export * from './story/story';
export * from './story/facts';
export * from './service/constructions';
export * from './service/selectors';
export * from './service/service';
export * from './version_conditionals';
export {
  CURRENT_LANGUAGE_VERSION,
  PLATFORM_DEPRECATED_LANGUAGE_VERSIONS,
  PLATFORM_SUPPORTED_LANGUAGE_VERSIONS,
  isLegacyLanguageVersion,
  languageVersionDiagnostic,
  languageVersionStanding,
  runHostUnits,
} from './language_version';
