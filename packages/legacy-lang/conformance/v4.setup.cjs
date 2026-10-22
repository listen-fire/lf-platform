// On this branch the v4 corpus is its own pre-merge copy (c39a99d6) of the version-4 tests, adapted to the host interface exactly as v1-v3 were carried.
// Runs a conformance corpus under language version 4 ("Luminous Owl", the
// language from v0.11.0 until version 5). Every parse, check, story and run that
// names no version compiles and executes under the current version, so making
// the current version 4 puts the whole verbatim corpus under 4 without
// touching a fixture.
const path = require('path');
const { assertSourcesResolve } = require('./source_tripwire.cjs');

assertSourcesResolve(require.resolve);

const LANGUAGE_VERSION = require.resolve('movement-lang/language_version');
const LEGACY_LANGUAGE_VERSION = path.resolve(__dirname, '../language_version.ts');

// The corpus reads the current version from the language package (as it did
// when the two were one) and this package reads its default from its own
// table: both are the corpus's integer. A platform entry given no pin (the
// engine dispatch, the authoring defaults) reads the installed language's
// LANGUAGE_VERSION instead: here it is the corpus's legacy id, so the corpus
// runs at its pin through the legacy path, as its saved movements would.
jest.mock(LANGUAGE_VERSION, () => ({
  ...jest.requireActual(LANGUAGE_VERSION),
  CURRENT_LANGUAGE_VERSION: 4,
  LANGUAGE_VERSION: '4',
}));
jest.mock(LEGACY_LANGUAGE_VERSION, () => ({
  ...jest.requireActual(LEGACY_LANGUAGE_VERSION),
  CURRENT_LANGUAGE_VERSION: 4,
}));

require('./frozen_routing.cjs');
