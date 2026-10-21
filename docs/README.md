# Documentation

- [`getting-started-lf.md`](getting-started-lf.md): running movements from a project folder with the `lf` command. [`core-slots.md`](core-slots.md): the modules `lf.yaml`'s `core:` chooses (models, judge, store, files). [`embedding.md`](embedding.md): running the engine inside your own product.
- [`editor-zed.md`](editor-zed.md): highlighting and the language server for `.mvt` files in the Zed editor.
- [`contracts/`](contracts/README.md): the versioned contracts the movement core speaks, with an index of the versions each release supports and deprecates. The catalog snapshot, the parked run state, the host families (the boundary between the engine and the code that runs it, and the entry points), the adapter protocol a remote adapter serves, and the language versions.
- [`language/dancing-wren-migration.md`](language/dancing-wren-migration.md): migrating an automation to language version 5, Dancing Wren. This repository serves version 5 only; upgrading an older automation is the platform's.

The reference for the movement language itself is the handbook the authoring agents read, in [`packages/handbook`](../packages/handbook), its chapters under [`chapters`](../packages/handbook/chapters).

## The platform, lf-platform

The hosted platform that runs movements for teams (the API, the web app, the admin app, the dev loop) is a separate repository, `lf-platform`, in the same GitHub organisation. Its documentation lives there:

- `dev-loop.md`: the local development loop. Boot the whole stack against real Postgres and Redis and fake third-party services, drive the UI, inject synthetic inbound events, and inspect what the system did.
- `api-ingest.md`: the ingest API, submitting records over HTTP with an API key.
- `security-google-oauth.md`: the security posture of the Google OAuth integration, written against the CASA Tier 2 requirements.
- `engine-host.md`: how the platform's hosts serve the host families: spend metering, the cross-run write locks, the production and test hosts, and what stays outside the contract.
- `deploy/`: the self-hosting runbook (`SELF_HOSTING.md`, start here), the upgrade notes and the guides for Render, AWS, Vercel and bringing your own identity provider.

## The documentation site

`pnpm docs:build` builds a static site into `site/` (gitignored) from the handbook chapters and the guides and contracts above, then checks every internal link. The generator is [`scripts/docs/build.mjs`](../scripts/docs/build.mjs); it needs no install. The [`docs` workflow](../.github/workflows/docs.yml) publishes it to GitHub Pages on a `docs-v*` tag or a manual run, never on a branch push.

URL scheme (stable; the language server links to it):

- `/docs/v<N>/<page>#<anchor>`, where `N` is the language version (`/docs/v5/` is version 5, Dancing Wren).
- `<page>` is a handbook chapter id (`foundations`, `anatomy`, `expressions`, `writes`, `traversal`, `extraction`, `branching`, `listeners`, `asks`, `patterns`, `use-cases`, `runs`, `reference`, `builtins`), a guide (`getting-started-lf`, `core-slots`, `embedding`, `adapter-protocol`, `dancing-wren-migration`), or `contracts` and `contracts-<name>`.
- `<anchor>` is the heading's GitHub style slug: the handbook's `###` section names (`writes#identity`) are the same anchors the in-app handbook routes use.
- Pages are files, so `.html` also works (`/docs/v5/writes.html#identity`).
- A new language version adds an entry to `VERSIONS` in the generator; the older sections stay at their URLs.
