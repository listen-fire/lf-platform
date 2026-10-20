# Upgrading a Listen-Fire installation

An upgrade is one lever: the tag in `LISTEN_FIRE_VERSION`. Everything else — which units you run, your credentials, your data — is untouched by it.

The same procedure applies wherever the installation runs, because every deployment starts the same published images. Only the "pull and restart" step differs (compose here; a blueprint deploy or a `gcloud run deploy` elsewhere).

**Do it on a copy first.** Restore your snapshot into a throwaway installation, upgrade that, and run the checks. A migration that is wrong for your data is discovered there rather than in your production window.

## Before

**Read the release notes in [CHANGELOG.md](../CHANGELOG.md) for every tag between the one you are on and the one you are going to.** Releases are cumulative but their notes are not: a required environment variable introduced in `v0.2.0` still applies when you jump from `v0.1.0` to `v0.3.0`.

**Know which version you are on.** `curl -s http://localhost:8081/healthz/workers` reports it as `version`, and the web UI shows it under Settings → About.

## 1. Snapshot the database

There is no down-migration path. **The snapshot is the rollback.**

```bash
# from deploy/ — the bundled database
docker compose exec -T postgres pg_dump -U listenfire -Fc listenfire > listenfire-$(date +%Y%m%d-%H%M).dump
```

On an installation that names its own database, snapshot it the way that provider does (a Cloud SQL backup, an RDS snapshot) or run `pg_dump "$DATABASE_URL" -Fc` from anywhere that can reach it. There is no `postgres` container to exec into: see SELF_HOSTING.md, "Bringing your own datastores".

The `listen-fire-config` volume holds the encryption keys every stored credential is encrypted under. An upgrade never rewrites it — but a database restored without the matching config volume is permanently unreadable, so back it up too if you have not already (see SELF_HOSTING.md, "What the installation generates for itself").

## 2. Bump the tag

In `deploy/.env`:

```
LISTEN_FIRE_VERSION=v0.2.0
```

## 3. Pull and restart

```bash
# from deploy/
./up.sh core knowledge automations           # pulls the new tag and waits for health

# or, run compose yourself — COMPOSE_PROFILES in .env names the optional pieces
docker compose pull
docker compose up -d
```

**Either option is safe for an installation behind a real hostname.** `up.sh` supplies `API_BASE_URL`, `WEB_BASE_URL`, the three ports and `LISTEN_FIRE_BIND` only as defaults for an installation that names none, so a production `deploy/.env` survives an upgrade run through it with its own URLs and its own bind address intact.

On `v0.1.0` it did not: `up.sh` exported those values, an exported value wins over `deploy/.env`, and an upgrade through it silently republished the installation at localhost — every capability link unreachable, the session cookie no longer `Secure` and dropped by the browser, every re-registered webhook pointing at nowhere. **Upgrading FROM `v0.1.0`, use `docker compose`** — the `up.sh` you run is the old one in your checkout until you have pulled this repository too.

Migrations run as the one-shot `migrate` service, to completion, **before** the new api starts — the api's `depends_on` says so, so a restart never races the schema. That is where an upgrade fails if it is going to: `docker compose logs migrate`.

The same one-shot then runs the deploy check, once per release. Every saved automation is written in a language version; the check re-validates each one and moves none: an automation moves to a newer version only when someone upgrades it. It reports which ones validate cleanly under the new release's current version, and for the rest shows what stands in the way on the automation in the app and as a `Validation Issue` event. It never fails the upgrade. `up.sh` prints its summary once the api is healthy; `docker compose run --rm --no-deps --entrypoint /usr/local/bin/with-generated-env api node build/scripts/deploy_check.js --summary` prints it again.

Migrations are forward-only and append-only from `v0.1.0`. A published release never edits or removes a migration an earlier release applied, so the ledger of a running installation is always a prefix of the new version's, and applying the difference is the whole of the schema change.

## Disk

Images live on the boot disk — under containerd's own root by default, not just Docker's — so a small boot disk fills after two or three api versions (the api image alone is around 4GB), and a pull that runs out of space half way fails silently and leaves the installation on the old version. `up.sh` guards both ends of that: it refuses to start when the filesystem holding the image store has less than roughly twice the api image free, naming the path and the free and required GB, and — once the new version is healthy — it prunes every `ghcr.io/listen-fire/{api,web,admin}` tag except the one just started and one recorded rollback target, plus dangling layers. `--no-space-check` skips the refusal (for a machine this script cannot see the disk of, or an operator who has already freed space); `--keep-images` skips the pruning. Running `docker compose pull && docker compose up -d` yourself instead of `up.sh` gets neither — prune by hand with `docker images` and `docker rmi`.

## 4. Check

```bash
# the version you asked for is the version answering
curl -s http://localhost:8081/healthz/workers | grep -o '"version":"[^"]*"'

# every loop of every mounted unit, and nothing from a unit you do not run
curl -s http://localhost:8081/healthz/workers

# the units and identity provider this installation claims
curl -s http://localhost:8081/api/public/capabilities
```

Then sign in, open a page from each unit you run, and — if you run automations — run one you already trust and compare it to its last run before the upgrade.

`deploy/smoke.sh` is the full end-to-end version of these checks, but it builds from source and destroys its volumes between shapes, so it is a check on the code rather than on your installation. Do not point it at a stack you care about.

## Rolling back

Restore the snapshot and re-pin the previous tag. In that order — an older api against a newer schema is not a supported combination, and the migrations cannot be undone.

```bash
# from deploy/
docker compose down          # keeps the volumes
# put the previous tag back in .env
LISTEN_FIRE_VERSION=v0.1.0

docker compose up -d postgres
docker compose exec -T postgres psql -U listenfire -d postgres \
  -c 'DROP DATABASE listenfire' -c 'CREATE DATABASE listenfire'
docker compose exec -T postgres pg_restore -U listenfire -d listenfire < listenfire-<stamp>.dump

docker compose up -d
```

With your own database, the middle three commands are your provider's restore instead, and the first and last are unchanged.

Anything that happened between the upgrade and the rollback is in the newer database and not in the snapshot; it is lost. That window is the reason to upgrade a copy first and to keep the production window short.

**Do not `down -v`.** It destroys `listen-fire-config` along with the data, and every stored third-party credential in the database you just restored becomes permanently unreadable.
