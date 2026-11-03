// node author_lf.cjs <project> <unused> <describe_systems file> <out json>
// The listen-fire option's authoring: one real model session (the same model
// as every other agent here) writes the program in a project whose
// credentials are already added. Its system prompt is a general platform's
// (since 2026-11-03): what listen-fire is, the project's `listen-fire
// credential list`, the language primer (prompts.cjs) and how a failed run is
// handled. The user's request is the first message. Its tools:
//
//   describe_systems  `listen-fire catalog`'s text, made before any program
//                     existed: every connection the project holds, as
//                     listen-fire describes it
//   handbook_search   the handbook's language search (@listen-fire/handbook)
//   handbook_read     a handbook chapter or section, including each installed
//                     module's own chapter (system:stripe, system:attio, …)
//   example           `listen-fire example <words>`: checked micro examples
//   write_program     replace the program
//   lf_check          `listen-fire check`, as printed
//   test_run          one run, for real, on a webhook body the agent writes:
//                     @lf/stripe's own inbound code makes it the arrival its
//                     door would (as `listen-fire run --webhook` does), then
//                     `listen-fire run --event … --ephemeral`
//   web_search, web_fetch  the web every option searches (web.cjs)
//
// No example event is given (a platform has none before the first arrives).
// Before 2026-11-03 it was, with a description of each connection, the
// delivery's details and the tools read_program and lf_catalog. The test
// run's writes are made, to the stand-ins' mailbox and Slack, which
// compare.sh clears before the program goes live (the JavaScript test records
// them instead). Every command's output is given as listen-fire printed it,
// with the project's own path made relative. The second argument, once the
// example event, is kept for compare.sh's call and not read.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const { session, PRICES } = require('./agent_tools.cjs');
const { loadHandbook, PROJECT_MODULES } = require('./handbook.cjs');

const [project, , describeFile, out] = process.argv.slice(2);
const LF_BIN = process.env.LF_BIN || 'listen-fire';
const LF_SRC = process.env.LF_SRC || path.join(__dirname, '../../../../listen-fire');
const PROGRAM = 'movements/payment_failed.mvt';
const { request, environment, cheatsheet, lfDelivery, checkLf, exampleTool, runExample } = require('./prompts.cjs');
const { webTools, runWeb } = require('./web.cjs');
const describeSystems = fs.readFileSync(describeFile, 'utf8').trim();
const programPath = path.join(project, PROGRAM);
const realProject = fs.realpathSync(project);
const testEvent = path.join(path.dirname(out), `${path.basename(out, '.json')}_test_event.json`);
// A webhook body the agent writes, as @lf/stripe's door makes it: the arrival
// on its invoice's Changes, by the module's own code (modules/stripe/inbound.ts).
createRequire(path.join(LF_SRC, 'packages/module-kit/package.json'))('tsx/cjs');
const inbound = require(path.join(LF_SRC, 'modules/stripe/inbound.ts'));

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

// A general platform's prompt (since 2026-11-03): what listen-fire is, the
// project's connections as `listen-fire credential list` prints them, the
// language primer, and how a failed run is handled. Nothing about this task's
// systems: the catalog, handbook, example lookup and web search find those.
const SYSTEM = `You are an agent that sets up automations for your user. Automations are listen-fire programs: a .mvt file in this project, which \`listen-fire serve\` runs on every event it listens to, with no model involved.

When your user asks for one, write ${PROGRAM}. It must pass \`listen-fire check\`; it goes live under \`listen-fire serve\` once you finish. The project's connections (\`listen-fire credential list\`):

\`\`\`
${credentials}
\`\`\`

${lfDelivery}

${environment}

The language, in short (handbook_read and handbook_search reach the whole handbook):

${cheatsheet}

${checkLf} When you are done, finish with a short note to the user.`;

async function main() {
  const tools = [
    {
      name: 'describe_systems',
      description: "Every system this project is connected to, as listen-fire describes it (`listen-fire catalog`): each connection's types, their fields and kinds, what can be read and written.",
      input_schema: { type: 'object', properties: {} },
    },
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
    exampleTool,
    { name: 'write_program', description: `Replace ${PROGRAM} with this source, whole.`, input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
    { name: 'lf_check', description: 'Run `listen-fire check`: every diagnostic the program has.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'test_run',
      description: "Run the program once on an incoming webhook, for real: give its body as the connected system would send it (JSON). It reaches the listens of the project's connection that receives it; reads are made, and so are writes, to a test mailbox and Slack that are cleared before the program goes live. The run is kept out of the project's run history.",
      input_schema: { type: 'object', properties: { body: { type: 'object', description: 'The webhook body, as the sender would send it.' } }, required: ['body'] },
    },
    ...webTools,
  ];
  if (fs.existsSync(programPath)) fs.rmSync(programPath);
  const handle = async (name, input) => {
    switch (name) {
      case 'describe_systems':
        return describeSystems;
      case 'handbook_search':
        return handbook.search(String(input.query), input.kind);
      case 'handbook_read':
        return String(input.route) === 'index' ? handbook.index() : handbook.read(String(input.route));
      case 'example':
        return runExample(input, { cwd: project, relative });
      case 'write_program':
        if (typeof input.source !== 'string' || input.source.trim() === '') throw new Error('source must be the whole program');
        fs.writeFileSync(programPath, input.source);
        return `wrote ${PROGRAM} (${input.source.split('\n').length} lines)`;
      case 'lf_check':
        return lf(['check']);
      case 'test_run': {
        const body = typeof input.body === 'string' ? JSON.parse(input.body) : input.body;
        const parsed = inbound.eventOf(body);
        if (!parsed.ok) return `the stripe_account connection refused the body: ${parsed.message}\n(exit 1)`;
        fs.writeFileSync(testEvent, JSON.stringify({ external: 'stripe', event: { arrivals: [inbound.changeArrival(parsed.payload)] } }));
        return lf(['run', '--event', testEvent, '--ephemeral']);
      }
      default: {
        const answer = runWeb(name, input);
        if (answer === undefined) throw new Error(`no tool ${name}`);
        return answer;
      }
    }
  };
  // PROBE_ONLY: no model call. The example tool is called once through the
  // handler, and the prompt and tools are written out, to prove the plumbing.
  if (process.env.PROBE_ONLY) {
    const probe = await handle('example', { query: 'create or update by id' });
    console.log(`example probe (${probe.length} chars): ${probe.split('\n')[0]}`);
    fs.writeFileSync(out, `${JSON.stringify({ system: SYSTEM, user: request, tools, probe }, null, 1)}\n`);
    return;
  }
  const result = await session({ system: SYSTEM, user: request, tools, handle, maxCalls: 60 });
  const source = fs.existsSync(programPath) ? fs.readFileSync(programPath, 'utf8') : null;
  fs.writeFileSync(out, `${JSON.stringify({ system: SYSTEM, user: request, tools: tools.map((t) => ({ name: t.name, description: t.description })), prices: PRICES, source, ...result }, null, 1)}\n`);
  console.log(`lf authoring: ${result.modelCalls} model call(s), $${result.costUsd.toFixed(4)}, ${result.ms} ms, stop ${result.stopReason}, program ${source ? `${source.split('\n').length} lines` : 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
