// node author_lf.cjs <project> <example event file> <describe_systems file> <out json>
// The listen-fire option's authoring: one real model session (the same model
// as every other agent here) writes the program in a project whose
// credentials are already added. It is given the request, our retry email,
// the handbook's front page (what an authoring agent is handed first), the
// project's `lf credential list` and one example event. Its tools:
//
//   handbook_search   the handbook's language search (@listen-fire/handbook)
//   handbook_read     a handbook chapter or section, including each installed
//                     module's own chapter (system:webhook, system:mcp, …)
//   lf_catalog        `lf catalog`: what each connection the program imports
//                     holds, as lf describes it (the CRM's from its MCP tools)
//   read_program      movements/payment_failed.mvt as it stands
//   write_program     replace it
//   lf_check          `lf check`, as printed
//   test_run          `lf run --event <the example> --dry-run`: one run on the
//                     example event, reads made, nothing written
//
// The test run is the same single run on the same example event the
// JavaScript option's test_handler gets. Every command's output is given as
// lf printed it, with the project's own path made relative.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { session, PRICES } = require('./agent_tools.cjs');
const { loadHandbook, PROJECT_MODULES } = require('./handbook.cjs');

const [project, exampleFile, describeFile, out] = process.argv.slice(2);
const LF_BIN = process.env.LF_BIN || 'lf';
const LF_SRC = process.env.LF_SRC || path.join(__dirname, '../../../../listen-fire');
const PROGRAM = 'movements/payment_failed.mvt';
const { request, retryEmail, environment, cheatsheet, lfDelivery, checkLf } = require('./prompts.cjs');
const describeSystems = fs.readFileSync(describeFile, 'utf8').trim();
// The listen-fire-builder skill as it stands: its copy in listen-fire went with
// the split, and the live one is the platform's (apps/web/skill-src).
const SKILL = path.join(__dirname, '../../../apps/web/skill-src/listen-fire-builder/SKILL.md');
const example = JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
const programPath = path.join(project, PROGRAM);
const realProject = fs.realpathSync(project);
const exampleRun = path.join(path.dirname(out), `${path.basename(out, '.json')}_example_event.json`);
fs.writeFileSync(exampleRun, JSON.stringify({ external: 'webhook', credential: 'stripe_events', event: { adapterType: 'webhook', triggerType: 'webhook', payload: example } }));

const handbook = loadHandbook(LF_SRC, PROJECT_MODULES);

function relative(text) {
  return text.split(`${realProject}/`).join('').split(`${project}/`).join('').split(realProject).join('.').split(project).join('.');
}

function lf(args) {
  const ran = spawnSync(LF_BIN, args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const printed = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return `${relative(printed).trimEnd()}\n(exit ${ran.status})`;
}

const credentials = lf(['credential', 'list']).replace(/\n\(exit \d+\)$/, '');

const SYSTEM = `You are an agent that sets up automations for your user. Automations are listen-fire programs: a .mvt file in this project, which \`lf serve\` runs on every event it listens to, with no model involved.

When your user asks for one, write ${PROGRAM}. It must pass \`lf check\`; it goes live under \`lf serve\` once you finish. The project's connections are set up already (\`lf credential list\`):

\`\`\`
${credentials}
\`\`\`

- stripe_events: Stripe's webhooks reach it (Stripe signing, with the endpoint's secret). \`lf serve\` prints its URL, and Stripe sends the failed-payment events there.
- crm: the user's CRM, ${process.env.CRM_KIND === 'rest' ? 'Attio, through its connector' : 'over MCP'}.
- billing_mail: the billing mailbox, billing@ledgerline.io.
- team_slack: the team's Slack.

${lfDelivery}

${environment}

Our retry email:

${retryEmail}

An example of the event Stripe sends:

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

The language, in short (handbook_read and handbook_search reach the whole handbook):

${cheatsheet}

${checkLf} When you are done, finish with a short note to the user.`;

async function main() {
  const tools = [
    {
      name: 'describe_systems',
      description: "Every system this project is connected to, as lf describes it (`lf catalog`): each connection's types, their fields and kinds, what can be read and written.",
      input_schema: { type: 'object', properties: {} },
    },
    { name: 'read_skill', description: 'The listen-fire-builder skill: how to build automations with Listen-Fire for a user.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'handbook_search',
      description: "Search the language's handbook: built-ins, concepts, recipes. Answers up to five entries, each with the anchor handbook_read takes.",
      input_schema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['function', 'concept', 'recipe'] } }, required: ['query'] },
    },
    {
      name: 'handbook_read',
      description: 'Read the handbook: "index" for its index, a chapter ("anatomy", "system:mcp"), one section ("branching#if-else"), or a front page section ("front#maybe-absent").',
      input_schema: { type: 'object', properties: { route: { type: 'string' } }, required: ['route'] },
    },
    { name: 'lf_catalog', description: 'Run `lf catalog`: the catalog the program is checked against, as JSON (each imported connection, its types and fields).', input_schema: { type: 'object', properties: {} } },
    { name: 'read_program', description: `${PROGRAM} as it stands.`, input_schema: { type: 'object', properties: {} } },
    { name: 'write_program', description: `Replace ${PROGRAM} with this source, whole.`, input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
    { name: 'lf_check', description: 'Run `lf check`: every diagnostic the program has.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'test_run',
      description: 'Run `lf run --event <the example event> --dry-run`: the program once on the example event. Reads are made (the CRM is real); writes are shown, not made.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
  if (fs.existsSync(programPath)) fs.rmSync(programPath);
  const handle = async (name, input) => {
    switch (name) {
      case 'describe_systems':
        return describeSystems;
      case 'read_skill':
        return fs.readFileSync(SKILL, 'utf8');
      case 'handbook_search':
        return handbook.search(String(input.query), input.kind);
      case 'handbook_read':
        return String(input.route) === 'index' ? handbook.index() : handbook.read(String(input.route));
      case 'lf_catalog':
        return lf(['catalog']);
      case 'read_program':
        return fs.existsSync(programPath) ? fs.readFileSync(programPath, 'utf8') : `(${PROGRAM} does not exist yet)`;
      case 'write_program':
        if (typeof input.source !== 'string' || input.source.trim() === '') throw new Error('source must be the whole program');
        fs.writeFileSync(programPath, input.source);
        return `wrote ${PROGRAM} (${input.source.split('\n').length} lines)`;
      case 'lf_check':
        return lf(['check']);
      case 'test_run':
        return lf(['run', '--event', exampleRun, '--dry-run']);
      default:
        throw new Error(`no tool ${name}`);
    }
  };
  const result = await session({ system: SYSTEM, user: request, tools, handle, maxCalls: 60 });
  const source = fs.existsSync(programPath) ? fs.readFileSync(programPath, 'utf8') : null;
  fs.writeFileSync(out, `${JSON.stringify({ system: SYSTEM, user: request, tools: tools.map((t) => ({ name: t.name, description: t.description })), prices: PRICES, source, ...result }, null, 1)}\n`);
  console.log(`lf authoring: ${result.modelCalls} model call(s), $${result.costUsd.toFixed(4)}, ${result.ms} ms, stop ${result.stopReason}, program ${source ? `${source.split('\n').length} lines` : 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
