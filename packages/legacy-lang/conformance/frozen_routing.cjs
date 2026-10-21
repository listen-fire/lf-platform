// A corpus written against an older release imports the language package's
// parse entries directly (`parseMovementExpression` from 'movement-lang'), and
// under the corpus's version (below 5) they are asked for a pin the language
// release no longer reads. Routed here as the platform routes every parse
// (../parser/rust_parser.ts): a version the release supports goes to its own
// wasm, any other to the frozen parser. A text read with no version reads
// under the corpus's version, as it did when the release served it.
const path = require('path');

const LANGUAGE_VERSION = require.resolve('movement-lang/language_version');
const RUST_PARSER = require.resolve('movement-lang/parser/rust_parser');
const FROZEN = path.resolve(__dirname, '../wasm/frozen_parser.ts');

jest.mock(RUST_PARSER, () => {
  const live = jest.requireActual(RUST_PARSER);
  const { callFrozenParser } = jest.requireActual(FROZEN);
  const frozen = live.parserOver((fn, input, extra) => callFrozenParser(fn, input, extra));
  const version = require(LANGUAGE_VERSION);
  const byLanguage = (languageVersion) => version.SUPPORTED_LANGUAGE_VERSIONS.has(languageVersion);
  return {
    ...live,
    rustParseProgram: (source, languageVersion) =>
      byLanguage(languageVersion) ? live.rustParseProgram(source, languageVersion) : frozen.program(source, languageVersion),
    rustParseNestedCall: (slot, at, languageVersion) =>
      byLanguage(languageVersion)
        ? live.rustParseNestedCall(slot, at, languageVersion)
        : frozen.nestedCall(slot, at, languageVersion),
    rustParseExpression: (source, languageVersion = version.CURRENT_LANGUAGE_VERSION) =>
      byLanguage(languageVersion) ? live.rustParseExpression(source, languageVersion) : frozen.expression(source, languageVersion),
  };
});
