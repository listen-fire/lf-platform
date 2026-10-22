# Documentation

This is the hosted platform's documentation: the API, the web app, the admin app, the dev loop and the deploy.

- [`dev-loop.md`](dev-loop.md): the local development loop. Boot the whole stack against real Postgres and Redis and fake third-party services, drive the UI, inject synthetic inbound events, and inspect what the system did.
- [`api-ingest.md`](api-ingest.md): the ingest API, submitting records over HTTP with an API key.
- [`security-google-oauth.md`](security-google-oauth.md): the security posture of the Google OAuth integration, written against the CASA Tier 2 requirements.
- [`engine-host.md`](engine-host.md): how the platform's hosts serve the host families: spend metering, the cross-run write locks, the production and test hosts, and what stays outside the contract.
- [`language/steady-lynx-migration.md`](language/steady-lynx-migration.md) and [`language/luminous-owl-migration.md`](language/luminous-owl-migration.md): history of the moves between the legacy integer versions 1 to 4. Upgrading automations pinned to the legacy ids 1 to 4 is this repository's.
- [`../deploy/`](../deploy/): the self-hosting runbook ([`SELF_HOSTING.md`](../deploy/SELF_HOSTING.md), start here), the upgrade notes and the guides for Render, AWS, Vercel and bringing your own identity provider.

## The language, listen-fire

The movement language (the parser, the checker, the engine, `lf`, the modules, the handbook and its documentation site) is a separate repository, `listen-fire`, in the same GitHub organisation. This repository installs its published `@listen-fire/*` packages. Its documentation lives there: the getting-started guide for `lf`, the core slots, embedding the engine, the editor support, the versioned contracts (`docs/contracts/`), the adapter protocol, and the migration guide to the 0.12 language.
