# Hero demo: capture

The run behind the site's 60-second demo video: an agent writing a
listen-fire automation over MCP, the checker refusing a stage Attio doesn't
have, a one-token fix, and the saved automation then running on a real email.
The run includes one small extraction call. Everything the video shows is
captured from a real run on the agent dev loop, with the repository's fakes
standing in for Gmail, Attio and Slack.

This directory only captures the run. The video is rendered in the site repo
(`listen-fire-site/video`), from the `data.js` built here and nothing else.

## Make it

Needs `ANTHROPIC_API_KEY` in the environment (the run's extraction is a real
model call).

```bash
cd docs/demo/hero
./scripts/boot.sh                       # dev loop up, team seeded, Gmail + Slack provisioned
./scripts/capture.sh                    # the agent's loop over MCP, then the email and its run
node scripts/build_data.cjs ../../../../listen-fire-site/video/data.js   # refuses a failed run
```

Then render in the site repo (see its `video/README.md`).

On a Mac, skip `boot.sh`: run `pnpm dev:loop:agent`, then
`pnpm dev:seed && pnpm dev:gmail setup`, with `ANTHROPIC_API_KEY` in
`apps/api/.env`. The scripts need `jq`.
Use the repository's Node (`.nvmrc`, 22.20) and its pinned pnpm (`corepack pnpm`):
under an older Node the API fails to start, and a native module built under
one Node version must be rebuilt for another.

`boot.sh` is for a fresh Linux cloud container. It pulls the Postgres and
Redis images through `mirror.gcr.io` (Docker Hub rate-limits these hosts),
shims `script` for `dev/loop.sh`, generates the Prisma client, and starts the
stack with `ANTHROPIC_BASE_URL=https://api.anthropic.com`, because a cloud
session points that variable at its own proxy. On a developer machine with
the stack already up it only seeds.

## What is in it

- `programs/draft.mvt`: the agent's first draft. It uses the user's word
  "Sourcing", which isn't one of Attio's stages, so `saveAutomation` refuses
  it with `MOV_ENUM_UNKNOWN_VALUE`.
- `programs/fixed.mvt`: the one-token fix ("Sourced"), which saves and goes live.
- `programs/founder_email.txt`: the founder's email body.
- `scripts/`: boot, capture (`mcp.sh` calls one connector tool the way an
  agent does), and the data build.

`.work/` (the captures and the minted API key) is gitignored.
