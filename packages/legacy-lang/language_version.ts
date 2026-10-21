// The version table is the language package's (movement-lang/language_version);
// this file adds the conditionals the TypeScript checker, parser and service
// branch on. It exists so a conformance corpus, written against the one
// module that held both, still finds both at that path.
export * from 'movement-lang/language_version';
export * from './version_conditionals';
