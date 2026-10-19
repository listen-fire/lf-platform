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
    // The engine moved out of apps/api into packages/movement-engine with its
    // paths kept (apps/api/src/X -> packages/movement-engine/X), so a corpus
    // test's relative import of an engine module resolves there.
    const moved = live.replace(/([\\/])apps[\\/]api[\\/]src(?=[\\/]|$)/, '$1packages$1movement-engine');
    if (moved === live) throw error;
    try {
      return defaultResolver(request, { ...options, basedir: moved });
    } catch (engineError) {
      return movedOutOfEngine(request, moved, options) ?? throwError(engineError);
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

function movedOutOfEngine(request, engineBasedir, options) {
  const match = engineBasedir.match(/^(.*[\\/]packages)[\\/]movement-engine(?=[\\/]|$)/);
  if (!match) return undefined;
  const inEngine = path.relative(path.join(match[1], 'movement-engine'), path.resolve(engineBasedir, request)).split(path.sep).join('/').replace(/\.ts$/, '');
  const target = OUT_OF_ENGINE[inEngine];
  return target === undefined ? undefined : options.defaultResolver(path.join(match[1], target), options);
}

function throwError(error) {
  throw error;
}
