# The frozen parser

`movement_parser.frozen.wasm` is the language's parser artifact as of the last
commit that read language versions 1 to 5 (`a6465f60c2`). It is the platform's
reader for movements pinned below version 5, and for the version-0 expression
surface (a probe's text, read as versions 1 to 4 read it). The language
release serves version 5 only; `frozen_parser.ts` loads this file, and
`parser/rust_parser.ts` routes each parse to it or to the live artifact.

- sha256: `3e38a1e57f65d9557588a38829840388bb0874443f75f2bdcc7e68ab9b6744c2`
- size: 1,318,624 bytes

Rebuild (byte-identical on macOS and Linux): check out `a6465f60c2`, run
`scripts/build-movement-wasm.sh`, and copy `packages/movement-lang/wasm/movement_parser.wasm` here.

Never rebuild it from a later commit: the point of the file is that it does
not change when the language does.
