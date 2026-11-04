// Release 0.12's package set, as one door. Everything the platform asks of
// 0.12 is answered here from 0.12's own packages, so a value or a class from
// this line can only enter the platform through @listen-fire/language-versions,
// and only as plain data. It exports what the registry's 0.12 entry provides,
// and nothing more.
//
// Never compiled in place: the image compiles it into the directory `pnpm
// deploy` installs it in, beside 0.12's packages (deploy/Dockerfile). A copy
// vendored into the api's build would resolve them from the api's own
// node_modules, which hold the current release.

export { LANGUAGE_VERSION } from '@listen-fire/movement-lang';
export * as errors from '@listen-fire/engine/public/errors';
export { checkSource, completionsAt, definitionAt, hoverAt } from './lane/check';
export { hostedModuleTypes } from './lane/modules';
export { manualInvocationEvent, manualListens, readEvent, resumeSegment, runSegment } from './lane/run';
export { gateFiring, isListenRow, listenersOf, readDelivery } from './lane/listen';
export {
  coerceCallbackValues,
  drainDueTimers,
  drainLeaves,
  queueAwaitWake,
  runCallbackBody,
  wakeAwaits,
} from './lane/resume';
