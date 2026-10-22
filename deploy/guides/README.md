# Platform guides

[`deploy/SELF_HOSTING.md`](../SELF_HOSTING.md) is the runbook: what each unit is, what it needs, what it still carries honestly, and every variable with what it does when unset. **Start there.**

These guides are the second step. They translate that runbook onto a specific platform, and they cover only the parts that change when you leave `docker compose` behind — where the migration step goes when there is no one-shot service, what the migration runner needs from a managed database, which health-check default is wrong, and which platform behaviour quietly breaks an in-process worker model.

| guide | when |
|---|---|
| [`render.md`](render.md) | Render. The API as a web service on the shipped image, managed Postgres and Redis beside it. A ready-made Blueprint (`deploy/render.yaml`) encodes the whole shape, and you name the units it runs. |
| [`vercel-plus-container.md`](vercel-plus-container.md) | You are on Vercel and want to stay there. The web app can; the API cannot, and this explains why and what to do instead. Fly.io is the worked example for the other half. |
| [`gcp-vm.md`](gcp-vm.md) | Google Cloud. One Compute Engine VM running the compose stack, then a section per datastore on moving it to Cloud SQL, Memorystore or GCS — each one a runbook, each one independent of the others. |
| [`aws.md`](aws.md) | ECS Fargate, RDS, ElastiCache, S3, ALB. Topology and gotchas, not console steps. |
| [`byo-auth.md`](byo-auth.md) | You want Listen-Fire to use your identity system rather than its own. The Principal and Directory contracts, what a provider must guarantee, and the two routes with their honest effort. |

Three things are true on every platform, and each of them has cost somebody a day:

- **The API is one long-running process** with its background workers inside it. There is no worker deployment to add, no serverless shape, and no scale-to-zero — a process that stops between requests stops the schedulers and the resume loops with it.
- **`GET /.well-known/health-check` answers `201`.** That is its contract. Platform health checks that default to expecting exactly `200` will drain a perfectly healthy target.
- **Two Postgres roles must exist before the first migration**, and you do not normally create them yourself. The compose file creates them from `postgres-init/00-roles.sql` on an empty data directory; on a managed database the migration runner runs that same file, which works as long as the user in `DATABASE_URL` holds `CREATEROLE`. When it does not, the runner stops before applying anything and tells you to run the file as a superuser.
- **A datastore is a variable, not a deployment shape.** Postgres, Redis and the object store each move to a managed service on their own, by naming yours; on compose that also takes the bundled service out of the composition. What each one needs is in [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Bringing your own datastores", and these guides carry only the part that is specific to the platform.

One more thing changes off compose: the compose stack generates its own secrets into a Docker volume on first boot, and nothing does that for you elsewhere. Mint them once, keep them where you keep secrets, and never rotate the two encryption keys — see [`SELF_HOSTING.md`](../SELF_HOSTING.md), "What the installation generates for itself".

Registering your own Slack app, Google OAuth client, WhatsApp number and the rest is platform-independent and is the longest-lead work in any real deployment. It lives in [`SELF_HOSTING.md`](../SELF_HOSTING.md), "Registering your own third-party apps", and it belongs at the start of a project rather than the end.

## A cloud `lf` beside the platform

A cloud `lf` that keeps its credentials here ([`SELF_HOSTING.md`](../SELF_HOSTING.md), "A cloud `lf` keeping its credentials here") needs one API key, and nothing else to keep running.

- **Minting the key.** In production, create it on the API keys settings page of the team it is for, ticking the `secrets` scope and no other. Locally, `pnpm dev:lf-secrets-key` mints one for the dev loop's team and prints it on the last line. The plaintext is shown once; put it in the `lf` project's environment as `LF_SECRET__PLATFORM_SECRETS__TOKEN`.
- **Rotating it.** Mint a new key, set it in the `lf` project's environment and restart `lf`, then revoke the old key. A revoked key is refused at once, so revoke after `lf` is running on the new one. `pnpm dev:lf-secrets-key` does the same locally: it revokes the previous dev key as it mints the next.
- **Maintenance.** None. The table that makes a platform refresh wait for `lf` holds one short lease per credential, which lapses by itself if `lf` stops mid-refresh.
