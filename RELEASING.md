# Releasing

This repository releases the platform: the container images, under `v*` tags. The language (the crates, the `@listen-fire/*` packages, the `lf` binaries and the documentation site) is released from `listen-fire`, in the same GitHub organisation, under its own tags. The two version numbers were aligned once, at 0.12.0, and are independent from then on.

A release of the platform installs a stated version of each `@listen-fire/*` package it consumes (set in the workspace's `package.json` files). Raise those first, regenerate the lockfile, and gate, before tagging.

## Pre-release (run in this order, from a clean `main`)

A suffixed tag never moves `:latest`.

1. Push the branch.
   ```sh
   git push origin main
   ```
2. Push the tag. The `release` workflow builds and pushes the five images to `ghcr.io/listen-fire/`: `api`, `api-slim`, `web`, `admin` and `fake-channels`.
   ```sh
   git tag v0.12.0-rc.4
   git push origin v0.12.0-rc.4
   ```

## Promoting to a full release

1. Set the plain version (e.g. `0.12.0`) wherever the platform states its own version. In `CHANGELOG.md`, rename the pre-release heading to the version and date, and drop the "preview" wording once it is no longer true.
2. Push the plain tag (`v0.12.0`): the images also get `:latest`.
3. Operators pin `LISTEN_FIRE_VERSION` in `deploy/.env` and move only when they change that line; `deploy/UPGRADING.md` says what each release asks of them.
