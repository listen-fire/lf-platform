// The engine reads movement-lang through this specifier; it must be the
// TypeScript sources, never a compiled copy (see the tripwire's message).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertResolvesToSource } = require('../../../../packages/legacy-lang/conformance/source_tripwire.cjs');

assertResolvesToSource('movement-lang', require.resolve('movement-lang'));
assertResolvesToSource('legacy-lang/cron', require.resolve('legacy-lang/cron'));
