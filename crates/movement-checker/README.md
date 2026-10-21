# listen-fire-checker

The movement language's checker: given a movement's source and a catalog
snapshot (the adapters, credentials and plugins it may use), it reports the
diagnostics the language defines, in the TypeScript checker's shape.

```rust,ignore
use movement_checker::{check_source, CheckOptions, host::native::NativeZones};
let options = CheckOptions { language_version: 5, upgrading_from: None, zones: &NativeZones };
let diagnostics = check_source(source, &catalog, options)?;
```

Most programs reach it through `listen-fire` (the facade crate) or
`listen-fire-engine`'s `embed::check`. PORT.md and PARITY.md in this
directory record the port from TypeScript and its last native parity run;
the parity harness is now the platform's (`packages/legacy-lang/parity`),
comparing the TypeScript checker with the committed wasm on version 5.
