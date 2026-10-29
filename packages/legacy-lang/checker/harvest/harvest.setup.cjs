// Records, for every program the checker is handed while a test corpus runs,
// the source text that parsed to it, the catalog the check actually consulted
// (as a `CatalogSnapshot`), the language version and the diagnostics — the
// checker's conformance oracle (../__test__/checks_regression.unit.test.ts).
//
// The catalog is recorded rather than projected: a test's catalog can answer
// per construction (a custom `instantiate`, `constructionArgOptions`), which
// `catalogSnapshotOf` would flatten. Every answer the check received is put
// into the snapshot under the key `fromCatalogSnapshot` looks it up by, and
// the snapshot is then asked the same questions; an answer it cannot give
// back marks the record with a `note`, so a lossy record is never silent.
//
// Appends JSON lines to $HARVEST_OUT. Run through ./jest.harvest.cjs.
const fs = require('fs');
const path = require('path');

const OUT = process.env.HARVEST_OUT;
const PACKAGE = path.resolve(__dirname, '../..');
const CHECK = path.join(PACKAGE, 'checker/check.ts');
const PARSE = path.join(PACKAGE, 'parser/parse.ts');
const RUST_PARSE = path.join(PACKAGE, 'parser/rust_parser.ts');
const LANGUAGE_VERSION = path.join(PACKAGE, 'language_version.ts');
const CATALOG = path.join(PACKAGE, 'checker/catalog.ts');
// The installed language's, resolved from this package (every corpus's
// movement-lang is the one catalog version, so one module serves them all).
const SNAPSHOT = 'movement-lang/service/snapshot';
const SCAN = 'movement-lang/parser/scan';
const RUST_CHECK = 'movement-lang/checker/rust_checker';
const RELEASE_VERSION = 'movement-lang/language_version';

const testFile = path.relative(PACKAGE, expect.getState().testPath || '');
const REPLAY = path.join('checker', '__test__', 'checks_regression');
const SPELLED_FOR = /[\\/]checker[\\/]__test__[\\/]surface_spelling\.ts/;
function insideSpelledFor() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  try {
    return SPELLED_FOR.test(new Error().stack || '');
  } finally {
    Error.stackTraceLimit = limit;
  }
}
const records = [];

// Must stay identical to `canonical` in parser/expression/__test__/lowering_fixture.ts.
function canonical(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

// Key order is kept: a schema's field order reaches diagnostic messages
// ("it has: Title, Colour"), so a recorded answer is never canonicalised.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const currentVersion = () => require(LANGUAGE_VERSION).CURRENT_LANGUAGE_VERSION;
// The pin holds this copy's integer versions; the corpora hand them in as
// numbers or as their text ('5').
const integerOf = (version) => (/^\d+$/.test(String(version)) ? Number(version) : version);
// This copy's spelling of the 0.12 surface, which a release pin's check is
// recorded under (legacy-lang language_version.ts).
const DIALECT = 5;

// The source (and parse version) behind each Program, by identity: the record
// carries the exact text, never a re-serialised AST.
const parsedFrom = new WeakMap();

// Every parse of a program for this copy's checker goes through the parser
// router: `parseProgram` and the TypeScript engine's `parsePinned` both read
// by it.
jest.mock(RUST_PARSE, () => {
  const actual = jest.requireActual(RUST_PARSE);
  const rustParseProgram = (source, languageVersion) => {
    const parsed = actual.rustParseProgram(source, languageVersion);
    if (parsed.ok) parsedFrom.set(parsed.value, { source, version: integerOf(languageVersion) });
    return parsed;
  };
  return { ...actual, rustParseProgram };
});

// `mockCatalog` hands back its fixture entry, inline schema included; the
// schema is `instantiate`'s answer and is recorded there, not on the spec.
function specOf(answer) {
  if (answer === undefined) return undefined;
  const { schema: _schema, ...spec } = answer;
  return plain(spec);
}

function recordingCatalog(catalog) {
  const calls = { adapter: new Map(), credential: new Map(), plugin: new Map(), instantiate: [], options: [] };
  const recording = {
    adapter(name) {
      const answer = catalog.adapter(name);
      calls.adapter.set(name, specOf(answer));
      return answer;
    },
    credential(name) {
      const answer = catalog.credential(name);
      calls.credential.set(name, plain(answer));
      return answer;
    },
    plugin(name) {
      const answer = catalog.plugin(name);
      calls.plugin.set(name, plain(answer));
      return answer;
    },
    instantiate(adapter, args) {
      const answer = catalog.instantiate(adapter, args);
      calls.instantiate.push({ adapter, args: { ...args }, answer: plain(answer) });
      return answer;
    },
  };
  if (catalog.credentialNames) recording.credentialNames = () => catalog.credentialNames();
  // A package import asks every plugin's spec (`packageMembers`), so each is recorded.
  if (catalog.pluginNames) recording.pluginNames = () => catalog.pluginNames();
  if (catalog.models) recording.models = () => catalog.models();
  if (catalog.constructionArgOptions) {
    recording.constructionArgOptions = (input) => {
      const answer = catalog.constructionArgOptions(input);
      calls.options.push({ input: { ...input }, answer: plain(answer) });
      return answer;
    };
  }
  return { recording, calls };
}

function recordingResolveFile(resolveFile) {
  const served = new Map();
  return {
    resolveFile: (filePath) => {
      const answer = resolveFile(filePath);
      served.set(filePath, answer);
      return answer;
    },
    served,
  };
}

/** The snapshot that answers what `catalog` answered, plus the reasons it
 *  cannot, when it cannot. */
function snapshotOf(catalog, calls, served) {
  const { instanceSchemaKey, fromCatalogSnapshot } = require(SNAPSHOT);
  const { credentialArgOf, entryPositionKeyOf } = require(CATALOG);
  const { unwrapCredentialArg } = require(SCAN);
  const notes = [];

  const credentials = {};
  // Replay always lists its credentials, so the snapshot holds every name the
  // catalog would have listed — whether or not this check asked.
  if (catalog.credentialNames) {
    for (const name of catalog.credentialNames()) {
      const spec = catalog.credential(name);
      if (spec) credentials[name] = { adapters: [...spec.adapters] };
    }
  } else {
    notes.push('the catalog cannot list its credentials; a snapshot always can');
  }
  for (const [name, spec] of calls.credential) {
    if (spec && !(name in credentials)) credentials[name] = { adapters: [...spec.adapters] };
  }

  const adapters = {};
  const adapterEntry = (name) => {
    if (!(name in adapters)) {
      const spec = calls.adapter.has(name) ? calls.adapter.get(name) : specOf(catalog.adapter(name));
      if (spec === undefined) return undefined;
      adapters[name] = { ...spec, schemas: {} };
    }
    return adapters[name];
  };
  for (const name of calls.adapter.keys()) adapterEntry(name);

  for (const { adapter, args, answer } of calls.instantiate) {
    if (answer === undefined) continue;
    const entry = adapterEntry(adapter);
    if (!entry) {
      notes.push(`instantiate(${adapter}) answered a schema for an adapter the catalog does not know`);
      continue;
    }
    // The key exactly as `fromCatalogSnapshot.instantiate` derives it.
    const positionKey = entryPositionKeyOf(entry, args);
    const credentialArg = credentialArgOf(entry);
    let key;
    if (!credentialArg) {
      key = instanceSchemaKey({ positionKey });
    } else {
      const raw = args[credentialArg.name] === undefined ? undefined : args[credentialArg.name].trim();
      const credentialName = raw !== undefined ? (unwrapCredentialArg(raw) ?? raw) : raw;
      if (!credentialName) {
        notes.push(`instantiate(${adapter}, ${canonical(args)}) answered a schema with no credential to key it by`);
        continue;
      }
      key = instanceSchemaKey({ credentialName, positionKey });
    }
    const seen = entry.schemas[key];
    if (seen !== undefined && canonical(seen) !== canonical(answer)) {
      notes.push(`instantiate(${adapter}) answered two schemas for key ${JSON.stringify(key)}`);
      continue;
    }
    entry.schemas[key] = answer;
  }

  for (const { input, answer } of calls.options) {
    if (answer === undefined) continue;
    const entry = adapterEntry(input.adapter);
    if (!entry) {
      notes.push(`constructionArgOptions answered for an adapter the catalog does not know: ${canonical(input)}`);
      continue;
    }
    const byCredential = (entry.constructionArgOptions ??= {});
    const byArg = (byCredential[input.credentialName ?? ''] ??= {});
    byArg[input.arg] = [...answer];
  }

  const plugins = {};
  for (const [name, spec] of calls.plugin) if (spec !== undefined) plugins[name] = spec;

  const snapshot = { adapters, credentials, plugins };
  if (catalog.models) snapshot.models = [...catalog.models()];
  if (served) {
    snapshot.files = {};
    for (const [filePath, answer] of served) if (answer !== undefined) snapshot.files[filePath] = { source: answer.source };
  }

  // Ask the snapshot every question the check asked, and compare.
  const replay = fromCatalogSnapshot(snapshot);
  const differs = (label, recorded, replayed) => {
    // Order-sensitive, for the same reason answers keep their key order.
    if (JSON.stringify(recorded) !== JSON.stringify(plain(replayed))) notes.push(`${label} does not replay from the snapshot`);
  };
  for (const [name, answer] of calls.adapter) differs(`adapter(${name})`, answer, replay.adapter(name));
  for (const [name, answer] of calls.credential) differs(`credential(${name})`, answer, replay.credential(name));
  for (const [name, answer] of calls.plugin) differs(`plugin(${name})`, answer, replay.plugin(name));
  for (const { adapter, args, answer } of calls.instantiate) {
    differs(`instantiate(${adapter}, ${canonical(args)})`, answer, replay.instantiate(adapter, args));
  }
  for (const { input, answer } of calls.options) {
    differs(`constructionArgOptions(${canonical(input)})`, answer, replay.constructionArgOptions(input));
  }
  if (catalog.credentialNames) differs('credentialNames()', [...catalog.credentialNames()], replay.credentialNames());
  return { snapshot, notes: [...new Set(notes)] };
}

// A run on the Rust engine is checked by the installed language's Rust
// checker (checkSourceInRust) under the release pin, past checkProgram: its
// program is recorded with this copy's answer on the same snapshot, under the
// version this copy spells that release as (5), so the engine's runs and the
// upgrade loop's rewrites reach the corpus too. A pin this copy has no
// spelling for (a release the installed language does not read, a move up
// from one release to another) is recorded as skipped, by name.
jest.mock(RUST_CHECK, () => {
  const actual = jest.requireActual(RUST_CHECK);
  const dialectOf = (pin) => {
    if (pin === undefined) return undefined;
    if (/^\d+$/.test(String(pin))) return Number(pin);
    return jest.requireActual(RELEASE_VERSION).compatible(pin) ? DIALECT : null;
  };
  const checkSourceInRust = (source, snapshot, options) => {
    const result = actual.checkSourceInRust(source, snapshot, options);
    const version = dialectOf(options.languageVersion);
    const upgradingFrom = dialectOf(options.upgradingFrom);
    if (version === null || upgradingFrom === null) {
      records.push({ skipped: `a Rust check under ${options.languageVersion} from ${options.upgradingFrom}, which this copy has no version for`, file: testFile });
      return result;
    }
    const { parseProgram, MovementParseError } = jest.requireActual(PARSE);
    let program;
    try {
      program = parseProgram(source, { languageVersion: version });
    } catch (e) {
      // A text this copy's parse refuses is not a check record.
      if (e instanceof MovementParseError) return result;
      throw e;
    }
    try {
      const { checkProgram } = jest.requireActual(CHECK);
      const { fromCatalogSnapshot, resolveFileFromSnapshot } = require(SNAPSHOT);
      const resolveFile = resolveFileFromSnapshot(snapshot);
      const diagnostics = checkProgram(program, fromCatalogSnapshot(snapshot), {
        languageVersion: version,
        ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
        ...(resolveFile ? { resolveFile } : {}),
      });
      records.push({
        source,
        version,
        ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
        snapshot: plain(snapshot),
        diagnostics: JSON.parse(canonical(diagnostics)),
        file: testFile,
      });
    } catch (e) {
      records.push({ harvestError: String(e && e.stack ? e.stack : e), file: testFile });
    }
    return result;
  };
  return { ...actual, checkSourceInRust };
});

jest.mock(CHECK, () => {
  const actual = jest.requireActual(CHECK);
  const checkProgramWithLink = (program, catalog, options) => {
    // A test's text respelled for version 5 (`spelledFor`) is checked again
    // and again by the upgrade loop; those passes are the loop's, not the
    // test's, and pinning them would triple the corpus for nothing it checks.
    if (insideSpelledFor()) return actual.checkProgramWithLink(program, catalog, options);
    const parsed = parsedFrom.get(program);
    if (!parsed) {
      records.push({ skipped: 'a program the parser router did not produce', file: testFile });
      return actual.checkProgramWithLink(program, catalog, options);
    }
    const { recording, calls } = recordingCatalog(catalog);
    const files = options && options.resolveFile ? recordingResolveFile(options.resolveFile) : undefined;
    const version = integerOf((options && options.languageVersion) ?? currentVersion());
    const result = actual.checkProgramWithLink(program, recording, {
      ...options,
      ...(files ? { resolveFile: files.resolveFile } : {}),
    });
    try {
      const { snapshot, notes } = snapshotOf(catalog, calls, files && files.served);
      records.push({
        source: parsed.source,
        version,
        ...(parsed.version !== version ? { parseVersion: parsed.version } : {}),
        ...(options && options.upgradingFrom !== undefined ? { upgradingFrom: integerOf(options.upgradingFrom) } : {}),
        snapshot,
        diagnostics: JSON.parse(canonical(result.diagnostics)),
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        // Where the text lives: the pin holds only its hash (../../conformance/checks_pin.ts).
        file: testFile,
      });
    } catch (e) {
      records.push({ harvestError: String(e && e.stack ? e.stack : e), file: testFile });
    }
    return result;
  };
  // `checkProgram` calls `checkProgramWithLink` inside the module, past the mock.
  const checkProgram = (program, catalog, options) => checkProgramWithLink(program, catalog, options).diagnostics;
  return { ...actual, checkProgram, checkProgramWithLink };
});

afterAll(() => {
  // The regression replays the harvest's own output; feeding it back in would
  // pin the fixture to itself.
  if (testFile.startsWith(REPLAY)) return;
  if (!OUT || records.length === 0) return;
  fs.appendFileSync(OUT, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
});
