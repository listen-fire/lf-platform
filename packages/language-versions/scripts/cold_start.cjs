// A process's cold start with one run of a carried version: what it loads, and
// what that costs, when the first work it has for the version arrives. Prints
// one JSON line per phase. Run with ts-node's transpile-only hook:
//
//   node -r ts-node/register/transpile-only packages/language-versions/scripts/cold_start.cjs
//
// Phase `registry`: the registry is loaded and asked about every capability,
// as every door does; no carried package is loaded yet. Phase `loaded`: the
// version's run host is loaded on first use. Phase `ran`: one segment of a
// 0.12 Run now ran to its end on it.

const path = require('node:path');

// Anything of a 0.12 release: its packages (`movement-lang@0.12.13`, a module
// at `attio@0.12.7`, each installed under its own version) and this package.
const CARRIED = [/@0\.12\.\d/, new RegExp(`\\${path.sep}lang-0\\.12\\${path.sep}`)];
const loadedCarried = () => Object.keys(require.cache).filter((file) => CARRIED.some((marker) => marker.test(file))).length;

const started = process.hrtime.bigint();
const rssAtStart = process.memoryUsage().rss;
const phase = (name, extra = {}) =>
  console.log(
    JSON.stringify({
      phase: name,
      carriedModulesLoaded: loadedCarried(),
      msSinceStart: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
      rssGrowthMb: Math.round((process.memoryUsage().rss - rssAtStart) / 1e5) / 10,
      ...extra,
    }),
  );

async function main() {
  const registry = require('..');
  registry.runningOf('0.15.1');
  registry.checkingOf('0.12.0');
  registry.refusalOf('0.12.0', 'resume');
  registry.listeningOf('0.12.0');
  phase('registry');

  const running = registry.runningOf('0.12.13');
  if (running.kind !== 'carried') throw new Error('0.12 does not run on this build');
  const lane = await running.lane();
  phase('loaded');

  const refused = (what) => async () => {
    throw new Error(`${what} is not part of a cold start`);
  };
  const { InMemoryWriteLocks } = require('movement-engine/public/write-locks');
  const source = 'function echo(run: <manual-[:Invocation]->>) {\n  t = run.Text\n  return t\n}\nlisten to manual fire echo\n';
  const outcome = await lane.runSegment(
    {
      source,
      pin: '0.12.13',
      movementName: 'echo',
      event: lane.manualInvocationEvent({ key: 'cold-start', invocation: { firedAt: new Date().toISOString(), text: 'hi' } }),
      teamId: '00000000-0000-4000-8000-000000000012',
      firedAt: new Date().toISOString(),
      team: { credentials: [], files: [], connectOf: () => 'oauth', kgChangeWebhooks: false, mcpEnabled: false, whatsappNumber: null },
      parkRefusal: registry.resumeRefusal('0.12.13'),
    },
    {
      modules: { hostFor: refused('a module'), parts: {}, log: { debug() {}, info() {}, warn() {}, error() {} }, validateResults: true },
      credentials: { belongsTo: () => true },
      withFileOwners: (_owners, call) => call(),
      llm: { client: { call: refused('llm') }, extractCall: { call: refused('extract') }, transforms: { invoke: refused('plugins') }, arbitrateEntities: refused('judge') },
      files: { resolveFileText: refused('file text'), render: refused('render') },
      bindings: { record: refused('bindings'), findBoundCounterpart: refused('bindings'), delete: refused('bindings') },
      locks: new InMemoryWriteLocks(),
      actingUser: async () => null,
      control: { cancelled: async () => false, cancelledNow: async () => false, leaseLost: () => false },
    },
  );
  phase('ran', { outcome: outcome.kind });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
