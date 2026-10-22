// A corpus written against an older release imports the language package's
// parse entries directly (`parseMovementExpression` from 'movement-lang'), and
// under the corpus's version (below 5) they are asked for a pin the language
// release no longer reads. Routed here as the platform routes every parse
// (../parser/rust_parser.ts): a legacy integer goes to the frozen parser,
// handed that integer; any other pin to the release's own wasm, this copy's 5
// being the installed language. A text read with no version reads under the
// corpus's version, as it did when the release served it.
const path = require('path');

const LEGACY_LANGUAGE_VERSION = path.resolve(__dirname, '../language_version.ts');
const RUST_PARSER = require.resolve('movement-lang/parser/rust_parser');
const FROZEN = path.resolve(__dirname, '../wasm/frozen_parser.ts');

jest.mock(RUST_PARSER, () => {
  const live = jest.requireActual(RUST_PARSER);
  const { callFrozenParser } = jest.requireActual(FROZEN);
  const version = require(LEGACY_LANGUAGE_VERSION);
  const frozen = (n) => live.parserOver((fn, input, extra) => callFrozenParser(fn, input, [...extra, n]));
  const frozenVersion = (languageVersion) =>
    /^\d+$/.test(String(languageVersion)) && String(languageVersion) !== '5' ? Number(languageVersion) : undefined;
  // The version setup makes LANGUAGE_VERSION the corpus's id; this copy's 5 is
  // the release actually installed.
  const installed = jest.requireActual(require.resolve('movement-lang/language_version')).LANGUAGE_VERSION;
  const livePin = (languageVersion) => (String(languageVersion) === '5' ? installed : String(languageVersion));
  const route = (languageVersion, onLive, onFrozen) => {
    const n = frozenVersion(languageVersion);
    return n === undefined ? onLive(livePin(languageVersion)) : onFrozen(frozen(n));
  };
  return {
    ...live,
    rustParseProgram: (source, languageVersion) =>
      route(languageVersion, (pin) => live.rustParseProgram(source, pin), (parser) => parser.program(source)),
    rustParseNestedCall: (slot, at, languageVersion) =>
      route(
        languageVersion,
        (pin) => live.rustParseNestedCall(slot, at, pin),
        (parser) => parser.nestedCall(slot, at),
      ),
    rustParseExpression: (source, languageVersion = version.CURRENT_LANGUAGE_VERSION) =>
      route(languageVersion, (pin) => live.rustParseExpression(source, pin), (parser) => parser.expression(source)),
  };
});
