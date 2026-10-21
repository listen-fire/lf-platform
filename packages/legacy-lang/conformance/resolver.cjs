// Jest resolver for a language version's conformance corpus.
//
// A corpus is an older release's own test files, copied VERBATIM into
// `__conformance__/v<n>/` at the same relative position they had in that
// release (so `checker/__test__/x.unit.test.ts` sits at
// `__conformance__/v1/checker/__test__/x.unit.test.ts`). Their relative
// imports were written against that release's tree, so they resolve as if the
// file still sat at its original position — against the CURRENT code — except
// that a request landing on another corpus file resolves to the corpus copy,
// not to today's version of that test.
const path = require('path');

const CORPUS_SEGMENT = /[\\/]__conformance__[\\/]v\d+(?=[\\/]|$)/;

module.exports = (request, options) => {
  const { basedir, defaultResolver } = options;
  const match = basedir.match(CORPUS_SEGMENT);
  if (!match || !request.startsWith('.')) return defaultResolver(request, options);

  const corpusRoot = basedir.slice(0, match.index + match[0].length) + path.sep;
  try {
    const inCorpus = defaultResolver(request, options);
    if (inCorpus.startsWith(corpusRoot)) return inCorpus;
  } catch {
    // Not a corpus file — resolve against the original position below.
  }
  const live = basedir.replace(CORPUS_SEGMENT, '');
  try {
    return defaultResolver(request, { ...options, basedir: live });
  } catch (error) {
    // What the language package kept (the wasm bindings, the expression AST,
    // the catalog types, the version table) sits in packages/movement-lang at
    // the path it had when this package was one with it.
    const language = live.replace(/([\\/])packages[\\/]legacy-lang(?=[\\/]|$)/, '$1packages$1movement-lang');
    if (language !== live) {
      const kept = inLanguagePackage(request, live, options);
      if (kept !== undefined) return kept;
      // Not a kept file either — fall through to the engine's old places.
    }
    // The engine moved out of apps/api into packages/movement-engine with its
    // paths kept (apps/api/src/X -> packages/movement-engine/X), so a corpus
    // test's relative import of an engine module resolves there.
    const moved = live.replace(/([\\/])apps[\\/]api[\\/]src(?=[\\/]|$)/, '$1packages$1movement-engine');
    if (moved === live) throw error;
    try {
      return defaultResolver(request, { ...options, basedir: moved });
    } catch (engineError) {
      // The TypeScript engine (versions 1–4) later left the engine package for
      // the platform's packages/legacy-engine, its paths kept.
      const legacy = moved.replace(/([\\/])packages[\\/]movement-engine(?=[\\/]|$)/, '$1packages$1legacy-engine');
      try {
        const found = defaultResolver(request, { ...options, basedir: legacy });
        // Its run loop answers for the version a run is pinned to, as the one
        // the corpora were written against did.
        return /[\\/]legacy-engine[\\/]services[\\/]movement_engine[\\/]run\.ts$/.test(found)
          ? found.replace(/services[\\/]movement_engine[\\/]run\.ts$/, 'conformance/run.ts')
          : found;
      } catch {
        return movedOutOfEngine(request, moved, options) ?? throwError(engineError);
      }
    }
  }
};

// Files that later left the engine package for the contracts or the Node
// runtime it shares with the module kit, by their path inside the engine.
const OUT_OF_ENGINE = {
  'services/translation_graph/types': 'engine-contracts/catalog',
  'services/translation_graph/mutation_context': 'engine-contracts/mutation_context',
  'services/translation_graph/awaitable': 'engine-contracts/awaitable',
  'services/translation_graph/uniqueness': 'engine-contracts/uniqueness',
  'services/translation_graph/triggerConfig': 'engine-contracts/trigger_config',
  'services/plugins/spec': 'engine-contracts/plugin_spec',
  'services/knowledge_pipeline/output_v3/schemas': 'engine-contracts/expression/schemas',
  'services/knowledge_pipeline/output_v3/expression': 'engine-contracts/expression/expression',
  'lib/handbook_section': 'engine-contracts/handbook_section',
  'lib/models/registry': 'engine-contracts/model_names',
  'services/secrets/family': 'module-runtime/secrets/family',
  'services/secrets/oauth2': 'module-runtime/secrets/oauth2',
  'services/secrets/connect': 'module-runtime/secrets/connect',
  'services/secrets/memory': 'module-runtime/secrets/memory',
  'services/browser/browser': 'module-runtime/browser',
  'lib/utils/queue': 'module-runtime/queue',
};

// Platform files an older corpus mocks that later left apps/api/src, by that
// path, mapped to where they went (from the repository root). A mock replaces
// the module wholesale, so it only needs the path to resolve.
const LEFT_THE_PLATFORM = {
  // The knowledge pipeline's fact extraction was retired with the pipeline;
  // its fact search lives on in the knowledge library.
  'services/knowledge_pipeline/facts': 'apps/api/src/lib/knowledge/facts',
};

function movedOutOfEngine(request, engineBasedir, options) {
  const match = engineBasedir.match(/^(.*[\\/]packages)[\\/]movement-engine(?=[\\/]|$)/);
  if (!match) return undefined;
  const inEngine = path.relative(path.join(match[1], 'movement-engine'), path.resolve(engineBasedir, request)).split(path.sep).join('/').replace(/\.ts$/, '');
  const target = OUT_OF_ENGINE[inEngine];
  if (target !== undefined) return options.defaultResolver(path.join(match[1], target), options);
  const platformTarget = LEFT_THE_PLATFORM[inEngine];
  return platformTarget === undefined ? undefined : options.defaultResolver(path.join(match[1], '..', platformTarget), options);
}

// The language package's file at the position `request` names from `live` (a
// directory inside legacy-lang): its source beside this package in the
// language's own tree, or its build where it is installed (the platform).
function inLanguagePackage(request, live, options) {
  const ownRoot = live.match(/^(.*[\\/]packages[\\/]legacy-lang)(?=[\\/]|$)/)[1];
  const inPackage = path.relative(ownRoot, path.resolve(live, request));
  const manifest = options.defaultResolver('movement-lang/package.json', { ...options, basedir: ownRoot });
  const languageRoot = path.dirname(manifest);
  for (const candidate of [path.join(languageRoot, inPackage), path.join(languageRoot, 'dist', inPackage)]) {
    try {
      return options.defaultResolver(candidate, options);
    } catch {
      // Try the next place.
    }
  }
  return undefined;
}

function throwError(error) {
  throw error;
}
