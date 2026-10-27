# Embedding update demo

A small demo product built on `@listen-fire/embed`: listen-fire as a library
inside a SaaS. One customer's agent writes an automation against the
customer's own fields; then a person changes one field of a record in the
product, and the automation, running inside the product's server, updates
another field of the same record and posts to the customer's Slack. The run
shows:

- the request: when a deal is marked Won, set its onboarding to Kickoff
  booked and post it to `#deals` with its owner;
- one customer, Brightline Freight, whose `Company` has `Stage` (`Lead |
  Qualified | Won`), `Owner` and `Onboarding` (`Not started | Kickoff booked
  | Live`), and its own Slack workspace (a fake);
- the agent's loop over the customer's MCP endpoint: `getStarted`,
  `describeConnection` (the `Company` fields), `saveAutomation` (checked
  against those fields), `listAutomations`;
- the automation listening for `company.updated` narrowed to `field:
  "Stage", becomes: "Won"`, and writing to the record it was fired for
  (`write company { Onboarding: "Kickoff booked" }`);
- a person adding Halden Marine (`Qualified`, `Not started`): nothing runs;
- a person changing its Stage to Won through the product's `PATCH` route:
  one run, in the product's process, before the PATCH answers; the PATCH's
  own answer already shows `Onboarding: Kickoff booked`; `#deals` gains
  `Deal won: Halden Marine (owner: Priya Raman)`;
- a person changing only its Owner: the product raises `company.updated`,
  but the listen's `field` gate does not admit it, so nothing runs.

It records on our own product (`host/`), not on the platform and not on the
listen-fire example. The listen-fire example (`examples/embed-saas`) raises
only `company.created`, so a change to a record needed a host of its own. No
model is called: the automation makes no `ai` or `extract` call.

## The product

`host/` is the whole product, run on a listen-fire checkout's packages:

- `crm.ts`: the product's records (`CompanyStore`) and the module its
  customers' movements reach them through. It declares `company.created` and
  `company.updated`, and the listen keys `field` and `becomes`. An update
  event carries the record, the changed fields' new values (`fields`) and
  their previous ones (`previous`); the embedded host's gate reads those.
- `product.ts`: `createEmbeddedHost`, the customer's two connections, and
  the person's create and change, each dispatching its event.
- `authoring.ts`: the saved movements and runs, kept where the authoring
  tools (`@listen-fire/authoring-mcp`) read them.
- `server.ts`: the HTTP routes (`GET`, `POST`, `PATCH` on
  `/customers/:tenant/companies`, and the MCP endpoint).

Loop safety is the product's rule: only a person's change raises an event.
An automation's write goes through the module's `updateRecord`, which raises
none, so the automation's write to the same company cannot fire it again.
The `becomes: "Won"` gate would also refuse such an event (the write
changes Onboarding, not Stage), but the capture proves the product's rule:
the PATCH raises exactly one event.

The module marks `Company` as what a listen delivers (`fires: true` on its
entry point). Without it, the checker cannot see which record a listen's
event is about, and it saves a `field` or `becomes` it cannot check (a
misspelt field or option saves clean and never fires). With it, `field:
"Status"` is refused (`MOV_LISTEN_BAD_CONFIG`) and `becomes: "Closed Won"`
too (`MOV_ENUM_UNKNOWN_VALUE`).

## Make it

Needs `jq`, `openssl`, node 22, and a listen-fire checkout with its packages
installed (`pnpm install`), from 0.12.10 on.

```bash
cd docs/demo/embedding-update
LF_SRC=<listen-fire checkout> ./capture.sh
node build_data.cjs ../../../../listen-fire-site/video/embedding-update/data.js
```

`capture.sh` starts from nothing every time. It copies `host/` into `.work/`
beside a link to the checkout's `examples/embed-saas/node_modules`, so the
product runs on the checkout's own packages. It starts a fake Slack on a
free port, then the product (`host.cjs`), drives the customer's MCP endpoint
with JSON-RPC `tools/call` requests, as an agent does (`mcp.sh`), and makes
the person's changes through the product's own routes (`change.cjs`).
Everything it starts is stopped when it exits. It refuses a checkout with
local changes under `examples`, `packages` or `modules`.

`host.cjs` wraps three things on the running product, only to print what
they see, each line stamped with the time on the product's clock: each
request, each event raised, and each write to a company (by a person or by
an automation). It also fills the models slot with one that prints and
refuses any call (none is made).

## What is in it

- `programs/request.txt`: what the user asked for.
- `programs/automation.mvt`: the automation, as saved through the agent's
  tools. The text is the demo's own, not a model's.
- `programs/tenant.json`: the customer, its `Company` fields, its Slack seed.
- `programs/slack_brightline.json`: its channels (`#deals`, `#dispatch`),
  beside the fake's default ones.
- `programs/changes.json`: the company added, and the two changes.
- `build_data.cjs`: the captures into the video's `data.js`, its shape
  documented at its top. It refuses to build when the automation did not
  save, its Onboarding is not one of the customer's options, adding the
  company ran anything, the Won change did not start exactly one run, the
  record before it is not the one added, the PATCH's answer or the record
  after it is not Stage Won with Onboarding set, the PATCH raised other than
  one event (a loop) or the automation wrote the company other than once,
  `#deals` did not gain exactly the expected post, the run's own writes are
  not that update and that post, the run made a model call, the Owner change
  ran, posted or wrote anything, or the automation ran more than once in all.

## Where the figures come from

- `validatedUnder`: the core's version (`packages/movement-engine`), the
  branch the checkout is at, and its commit, as `0.12.10 (main@<commit>)`.
- `ms`: measured by `change.cjs`, from sending the request to its response.
  The product runs every listening automation before it answers.
- `automationWriteMs`: from the PATCH arriving at the product to the
  automation's write to the company, both on the product's clock.
- `run`: `inspectRun` on the customer's endpoint (`status`, `recordCount`,
  `writes`); `costUsd` is the PATCH answer's `spentMicrodollars` / 1e6;
  `modelCalls` is the models slot's printed calls during the PATCH.
- `record.before` / `record.after`: the product's own `GET` before and after
  the PATCH. `record.answered`: the PATCH's answer. `record.event`: the
  payload the product raised.
- `post`: the message the fake Slack gained during the PATCH.
