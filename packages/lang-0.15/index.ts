// Release 0.15's package set, as one door. Everything the platform will ask of
// 0.15 once it is carried is answered here from 0.15's own packages, so a value
// or a class from this line can only enter the platform through
// @listen-fire/language-versions, and only as plain data. It exports what the
// registry's 0.15 entry provides, and nothing more: today, the release it is.
//
// Never compiled in place: the image compiles it into the directory `pnpm
// deploy` installs it in, beside 0.15's packages (deploy/Dockerfile). A copy
// vendored into the api's build would resolve them from the api's own
// node_modules, which hold the current release.

export { LANGUAGE_VERSION } from '@listen-fire/movement-lang';
