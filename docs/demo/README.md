# Demo recordings

Each folder here records one of the site's demo videos: a real run of the
product, with the repository's fakes standing in for the third-party systems.
Nothing a video shows is written by hand.

- `dealflow/`: the homepage demo. A founder's email lands in Attio and Slack.
  It records on the platform's agent dev loop: an agent saves the automation
  over the real MCP connector (a draft the checker refuses, then the fix), and
  real trigger events run through the fakes.
- `field-service/`: a customer's WhatsApp message is logged to a job sheet,
  and an urgent one pages the on-call engineer in Slack. It records on the
  open-source `lf` CLI instead, with no dev loop: the platform's shared
  WhatsApp number only carries team members' own messages, not a customer's.
  How to make it is in its own README.

These folders only capture runs. The videos are rendered in the site repo
(`listen-fire-site/video/<video>/`), each from the `data.js` its recording
builds and nothing else.

## Make a dev-loop recording (dealflow)

Needs `ANTHROPIC_API_KEY` in `apps/api/.env` (the runs make real model
calls). The scripts need `jq`.

```bash
pnpm dev:loop:agent                     # in its own terminal
pnpm dev:seed
cd docs/demo/<video>
./capture.sh                            # the agent's loop over MCP, then the events and their runs
node build_data.cjs ../../../../listen-fire-site/video/<video>/data.js   # refuses a failed run
```

Each `capture.sh` provisions the systems its video uses and clears their fake
state first, so it re-runs cleanly from a fresh `pnpm dev:seed`. Then render
in the site repo (see its `video/README.md`).

Use the repository's Node (`.nvmrc`) and its pinned pnpm (`corepack pnpm`):
under an older Node the API fails to start, and a native module built under
one Node version must be rebuilt for another.

On a fresh Linux cloud container, run `scripts/boot.sh` instead of the first
two commands. It pulls the Postgres and Redis images through `mirror.gcr.io`
(Docker Hub rate-limits these hosts), shims `script` for `dev/loop.sh`,
generates the Prisma client, and starts the stack with
`ANTHROPIC_BASE_URL=https://api.anthropic.com`, because a cloud session
points that variable at its own proxy. On a developer machine with the stack
already up it only seeds.

## What is shared

These are for the dev-loop recordings only; `field-service/` uses none of them.

- `scripts/boot.sh`: the cloud boot above.
- `scripts/mint_key.ts`: mints an automation API key for the dev-loop team.
  Each `capture.sh` runs it first.
- `scripts/mcp.sh`: calls one connector tool the way an agent does, with
  that key.

`.work/` (the minted key here, each video's captures in its own folder) is
gitignored.
