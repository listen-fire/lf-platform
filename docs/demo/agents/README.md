# Agents demo

A subscription business (Ledgerline) bills in Stripe and keeps its customers
in a CRM its agent reaches over MCP. The user tells their agent: when a
payment fails, look the customer up in the CRM; monthly plans get the retry
email, yearly plans go to their account manager in `#accounts` on Slack. The
agent writes a listen-fire program for it rather than waking itself for every
event, and is woken once a day to review what the program could not handle.
The run shows:

- the draft refused by `listen-fire check`: it compares the plan to `"annual"`, but the
  CRM's MCP tool says the plan is one of `monthly | yearly`
  (`MOV_ENUM_UNKNOWN_VALUE`, read from the tool's own output schema);
- the one-word fix (`"yearly"`), which checks clean, and `listen-fire serve`;
- day 1: 20 signed `invoice.payment_failed` deliveries. 17 are handled with no
  model call; 3 are exceptions, failed runs, because the customer's Stripe
  billing email is not the email the CRM has;
- the next morning: the agent's daily review, a live model session
  (`claude-sonnet-5-5`) that reads the failed runs through the real `listen-fire runs`,
  queries the CRM, revises the program and runs `listen-fire check`. It is run three
  times from the same state; the first attempt whose revision checks clean and
  handles the three exceptions (a dry run of each) is put live under the
  running `listen-fire serve`, which picks up the edited file;
- day 2: 20 more deliveries through the revised program;
- the comparison: day 1's 20 events handled instead by a fresh agent per
  event (same model, tools on the same stand-ins), its calls, tokens, cost and
  time, and every way its emails and posts differ from the program's.

It records on the open-source `listen-fire` CLI.

## Make it

Needs `ANTHROPIC_API_KEY` in `apps/api/.env`, `jq`, `sqlite3`, `rsync`, node 22,
the platform API's dependencies installed (`apps/api/node_modules`: the
Anthropic and MCP SDKs), and a listen-fire checkout beside this repo (its fakes
stand in for Gmail and Slack).

```bash
cd docs/demo/agents
LF_BIN=<listen-fire binary> LF_SRC=<listen-fire checkout> LF_BRANCHES=webhook-module ./capture.sh
node build_data.cjs ../../../../listen-fire-site/video/agents/data.js
```

- The current recording is from listen-fire's `webhook-module` branch (lf
  0.12.9 plus `@lf/webhook`, signed Stripe-style webhooks with a declared
  payload). It already contains main's `@lf/mcp`. `validatedUnder` reads
  `0.12.9+webhook-module@<commit>`.
- A recording costs real model calls: three review sessions and twenty
  per-event sessions (about a dollar in all at the recorded prices).
- `ATTEMPTS` sets the number of review sessions (default 3).

## The three options (compare.sh)

The video's comparison is a second recording, `compare.sh`, run after
`capture.sh` (whose review it keeps for the closing note). It records on listen-fire
built from listen-fire's main (a detached checkout names the branch as
`LF_BRANCHES=main=<commit>`):

```bash
SCENARIO=mcp   LF_BIN=<listen-fire binary> LF_SRC=<listen-fire checkout> LF_BRANCHES=main ./compare.sh
SCENARIO=attio LF_BIN=<listen-fire binary> LF_SRC=<listen-fire checkout> LF_BRANCHES=main ./compare.sh
node build_data.cjs ../../../../listen-fire-site/video/agents/data.js
```

- The current recording is in two parts.
  - The per-event agent and JavaScript were recorded on 0.12.12,
    main@05dfcb1564. They do not run lf, so the lf build does not affect them.
  - listen-fire was re-recorded on main@8c9e723606 (0.12.12 plus
    `@lf/stripe`), with `ONLY_LF=1`. `validatedUnder` reads that build.
- `ONLY_LF=1` re-records listen-fire alone. It keeps the scenario's
  `capture/agent` and `capture/js` as they are and makes everything else anew.
  The events are the same each time, because `make_events.cjs` is seeded.

It is recorded twice, in two scenarios, all three options in each, so that
each comparison is like for like (`SCENARIO`; outputs in
`.work/compare/<scenario>/`, and `data.js` carries both):

- **MCP vs MCP** (`mcp`): the CRM is an MCP server whose tools are generic
  (`crm_server.cjs` with `CRM_SCHEMA=generic`): `plan` is a plain string in
  their output schemas, and a `describe_fields` tool answers the workspace's
  fields and each select's options as data. Nothing is announced when the
  options change. Every option reaches it over MCP: listen-fire through
  `@lf/mcp`, JavaScript and the per-event agent through the MCP SDK's client.
- **Native connector vs REST** (`attio`): the CRM is Attio, fake-channels'
  Attio behind `attio_crm.cjs`, the customers as `people` records with `plan` a
  select attribute. listen-fire reaches it through its native connector
  `@lf/attio`, which publishes the select's options to `listen-fire check`; JavaScript
  and the per-event agent through Attio's REST API with a plain HTTP helper
  (`crm_access.cjs`) and its reference (`programs/attio_rest.md`).

Each option is set up for success with generic capabilities only, and is
told the same things (`prompts.cjs`): the request ("annual"), our retry
email, the operating environment, and to check its work before it finishes
or acts.

- **Wake the agent for every event** (`baseline.cjs` behind
  `receivers.cjs agent`): a fresh session per delivery, with the CRM (its MCP
  tools, or a `crm_request` tool for its REST API), email, Slack and a
  key-value memory.
- **JavaScript** (`author_js.cjs`, `sandbox.cjs`, `receivers.cjs js`): the
  model writes `handler(event)` for a sandbox with `crm` (a plain MCP client,
  or `crm.request` for the REST API; no retry of its own either way, where
  listen-fire's `@lf/mcp` and `@lf/attio` retry 429 and 5xx with backoff),
  `email`, `slack`, a persistent `kv` and the runtime's timers. It can list
  the CRM's tools (or read its API reference) and test-run the handler.
- **listen-fire** (`author_lf.cjs`): the model gets the connected systems up
  front (`describe_systems`), the listen-fire cheat sheet (`programs/lf_cheatsheet.md`),
  the listen-fire-builder skill unchanged (the platform's
  `apps/web/skill-src` copy; listen-fire's own went with the split), the
  handbook, `listen-fire check` and a dry run.
  - Stripe is connected through listen-fire's Stripe module, `@lf/stripe`
    (credential `stripe_account`: an API key and the endpoint's signing
    secret). The program listens with
    `listen to pay { events: ["invoice.payment_failed"] }` and reads typed
    Invoice fields, amounts already in major units with their `Currency`.
  - The module's reads beyond the event (an invoice's customer or
    subscription) reach listen-fire's own fake Stripe API, seeded with the same
    customers (`stripe_api.cjs`; every read is kept in
    `capture/stripe_reads.jsonl`).
  - Before this, listen-fire used the generic `@lf/webhook` with a
    hand-declared Stripe payload. The JavaScript and agent options are
    unchanged.

Delivery is the same for JavaScript and listen-fire: each delivery is stored
and acknowledged before it runs (the sandbox endpoint; `listen-fire serve
--doors-only` and the host's worker, `listen-fire drain`). Every option gets the same
events, signed the same way (`Stripe-Signature`). listen-fire's go to
`@lf/stripe`'s door (`/hooks/stripe/stripe_account`), which checks that
signature itself. A failed run is not run
again by itself: the host wakes the agent (`wake.cjs`), a live session that
may inspect, fix, deliberately run it again, or tell the user. JavaScript's
agent runs it again by replaying the stored event through the live handler;
listen-fire's runs `listen-fire runs rerun <run-id>` (the failed run again as its next
attempt, on its own event and the program as it now stands; refused when the
failed attempt committed writes, unless `--force`, which makes them again). For listen-fire the
host also runs `listen-fire check` every 30 s and wakes the agent on new errors.
`stress.cjs` is the host.

The stressors, the same for all three (`make_events.cjs … plain`: every
Stripe email is the CRM's): the 3rd, 8th and 17th payment delivered twice; one
CRM call answered 503 (5th payment) and one 429 (15th), each with
Retry-After: 1; then the CRM renames `yearly` to `annual_plan` and, 45 s
later, 5 more payments arrive, 2 on that plan. In the Attio scenario the 503
and the 429 answer the next call that reads records, whoever makes it (armed
just before the payment's delivery): `@lf/attio` lists records page by page
and filters them itself, so its call names no customer. The rename is a
select option renamed in the workspace: the option keeps its id and takes the
new title, on every record.

`measure.cjs` measures each handler and program (lines, decision points,
hand-rolled concerns, I/O sites, credentials); its method is at its top.
A line of a multi-line JavaScript template string counts as a line. An
earlier version dropped such a line when it had no `${…}` and no closing
quote (the retry email's "We'll try again…" line).

JavaScript and listen-fire are authored three times each from the same state,
and every attempt goes through the stressors; the video shows the first.
`REHEARSE_JS` and `REHEARSE_LF` rehearse the stressors with a given handler
and program.

The review recording (`capture.sh`) predates this: its request says "yearly"
(`programs/request_review.txt`).

## What is in it

- `programs/request.txt`: what the user asks, for the three options. `programs/request_review.txt`: the earlier wording the review was recorded with.
- `programs/draft.mvt`, `programs/fixed.mvt`: the program before and after
  the fix. Both are scripted, as in the dealflow demo. The revision is not:
  the review session writes it, and `.work/capture/43_revised.mvt` is what
  went live.
- `programs/customers.cjs`: the stand-in world. 40 customers as the CRM has
  them and as Stripe has them; 3 on each day pay from a billing email the CRM
  does not have. Every Stripe subscription carries the CRM id in its metadata
  (`crm_id`).
- `programs/accounts_channel.json`, `programs/mailbox.json`: Slack's
  `#accounts` and the billing mailbox, seeded into the fakes.
- `attio_crm.cjs`, `crm_access.cjs`, `programs/attio_rest.md`: the Attio
  scenario's CRM (the customers seeded into fake-channels' Attio, and its
  REST API served in front of it with the token check, the call log and the
  injected 503 and 429), how the sandbox and the per-event agent reach the
  CRM in each scenario, and the REST reference they are given.
- `crm_server.cjs`: the CRM, an MCP server over streamable HTTP with two
  read-only tools (`find_customer_by_email`, `get_customer`), whose output
  schemas declare `plan` as the enum `monthly | yearly`.
- `make_events.cjs`, `deliver.cjs`: the stand-in Stripe. One
  `invoice.payment_failed` event per customer of a day, in Stripe's shape;
  each is signed with the endpoint secret (`Stripe-Signature`) and timed to
  the run it starts.
- `agent_tools.cjs`, `review.cjs`, `baseline.cjs`: the review and the per-event agent;
  `prompts.cjs`, `author_js.cjs`, `sandbox.cjs`, `author_lf.cjs`, `handbook.cjs`,
  `wake.cjs`, `measure.cjs`: the comparison's agents and measures;
  `receivers.cjs`, `stress.cjs`, `stripe_api.cjs`: its webhook endpoints,
  host and the Stripe API that `@lf/stripe` reads
  (`stripe_sender.cjs` is the previous round's sender). The
  review's tools are the program file, `listen-fire check`, `listen-fire runs`, `listen-fire runs show`
  and the CRM's MCP tools. The per-event agent's tools are the CRM's MCP tools,
  sending an email and posting to Slack.
- `signin.cjs`: Gmail's sign-in, the browser's part played against the fake.
- `build_data.cjs`: both recordings into the video's `data.js` (its shape and the
  source of every figure are at its top). It refuses to build when a payment
  is missing from an option, the used listen-fire attempt does not check clean
  or made a model call, or the chosen review revision does not check.

## How it differs from the story

- Exceptions are failed runs. The program ends a run it cannot handle with
  `fail(…)`, so the run record keeps the reason and the whole event. `listen-fire runs`
  lists the most recent 50 runs with their status, and has no filter by status
  or date. The review reads that list, then `listen-fire runs show` for each failed
  run.
- The CRM id is in the subscription's metadata, which Stripe copies onto the
  invoice (`subscription_details.metadata`). An invoice event names its
  customer by id only, so the customer object's own metadata is not in it.
- "Day 1", "the next morning" and "day 2" are minutes apart in the recording.
  Nothing in the review is told a date.
- The redeploy is listen-fire serve's own: it picks up the edited program file. The
  review sessions edit copies of the project, and the chosen revision is
  copied into the live project.
- The per-event agent is given our retry email word for word, as the program
  sends it. The user named "our retry email", so the agent would have it. It
  is given no wording for the Slack message.
