// Plain JavaScript on purpose: the deployed image installs this package with
// `pnpm deploy`, which resolves its 0.12 dependencies beside it. A compiled
// copy vendored into the api's build would resolve them from the api's own
// node_modules, which hold the current release. Keep it to re-exports; the
// types are index.d.ts.
'use strict';

exports.LANGUAGE_VERSION = require('@listen-fire/movement-lang').LANGUAGE_VERSION;
exports.errors = require('@listen-fire/engine/public/errors');
