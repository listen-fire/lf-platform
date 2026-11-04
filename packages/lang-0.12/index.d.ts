// Release 0.12's package set, as one door. Everything a caller needs from 0.12
// is re-exported here from 0.12's own packages, so a value or a class from this
// line can only enter the platform through @listen-fire/language-versions.
//
// It exports what the registry's 0.12 entry provides, and nothing more.

export { LANGUAGE_VERSION } from '@listen-fire/movement-lang';
export * as errors from '@listen-fire/engine/public/errors';
