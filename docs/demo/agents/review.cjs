// node review.cjs <project> <program file> <crm url> <crm token> <out json>
// The agent's daily review: one real model session, woken by the schedule's
// "daily review". It is told what it maintains and what the user asked for,
// and nothing about why yesterday's runs failed. Its tools:
//
//   read_program      the program file
//   write_program     replace the program file
//   lf_check          `listen-fire check` in the project, as printed
//   lf_runs           `listen-fire runs`, as printed
//   lf_runs_show      `listen-fire runs show <run-id>`, as printed
//   crm__<tool>       the CRM's MCP tools, as its server lists them
//
// Every listen-fire command runs the listen-fire this recording runs (LF_BIN, with the module
// sources LF_MODULES_DIR and LF_SERVE_MODULE when set). What a command prints
// is given to the model with the project's own path made relative, as from
// inside the project. Writes the whole session (every block, every tool call
// and its output, usage, cost) to <out json>. ANTHROPIC_API_KEY comes from the
// environment.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { crmTools, session, PRICES } = require('./agent_tools.cjs');

const [project, programFile, crmUrl, crmToken, out] = process.argv.slice(2);
const LF_BIN = process.env.LF_BIN || 'listen-fire';
const request = fs.readFileSync(path.join(__dirname, 'programs/request_review.txt'), 'utf8').trim();
const programPath = path.join(project, programFile);
const realProject = fs.realpathSync(project);

function relative(text) {
  return text.split(`${realProject}/`).join('').split(`${project}/`).join('').split(realProject).join('.').split(project).join('.');
}

function lf(args) {
  const ran = spawnSync(LF_BIN, args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const printed = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return `${relative(printed).trimEnd()}\n(exit ${ran.status})`;
}

const SYSTEM = `You maintain the automations one of your users has asked you for. Each automation is a listen-fire program: a .mvt file in this project, which \`listen-fire serve\` runs on every event it listens to, with no model involved.

The user asked for this one:

> ${request}

You wrote ${programFile} for it. You are woken once a day, by a schedule, to review the previous day's exceptions: the runs the program could not handle. Review them and, if the program can be improved so that events like them are handled, revise it. Everything the program already handles must keep working as the user asked.

- Never handle the events yourself. Your only lever is the program.
- A revision must pass \`listen-fire check\`. It goes live once you finish.
- If an exception cannot be handled by the program, leave the program as it is and say what the user needs to do.

When you are done, finish with a short note to the user: what you found, and what you changed.`;

async function main() {
  const crm = await crmTools(crmUrl, crmToken, 'review');
  const tools = [
    { name: 'read_program', description: `The program, ${programFile}.`, input_schema: { type: 'object', properties: {} } },
    {
      name: 'write_program',
      description: `Replace ${programFile} with this source, whole.`,
      input_schema: { type: 'object', properties: { source: { type: 'string', description: 'The whole program.' } }, required: ['source'] },
    },
    { name: 'lf_check', description: 'Run `listen-fire check` in the project: every diagnostic the program has.', input_schema: { type: 'object', properties: {} } },
    { name: 'lf_runs', description: 'Run `listen-fire runs`: the runs, most recent first (id, started, file:movement, status).', input_schema: { type: 'object', properties: {} } },
    {
      name: 'lf_runs_show',
      description: 'Run `listen-fire runs show <run-id>`: one run, its event, trace, writes and error.',
      input_schema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
    },
    ...crm.offered(),
  ];
  const original = fs.readFileSync(programPath, 'utf8');
  const handle = async (name, input) => {
    switch (name) {
      case 'read_program':
        return fs.readFileSync(programPath, 'utf8');
      case 'write_program':
        if (typeof input.source !== 'string' || input.source.trim() === '') throw new Error('source must be the whole program');
        fs.writeFileSync(programPath, input.source);
        return `wrote ${programFile} (${input.source.split('\n').length} lines)`;
      case 'lf_check':
        return lf(['check']);
      case 'lf_runs':
        return lf(['runs']);
      case 'lf_runs_show':
        return lf(['runs', 'show', String(input.run_id)]);
      default:
        if (name.startsWith('crm__')) return crm.run(name, input);
        throw new Error(`no tool ${name}`);
    }
  };
  const started = new Date().toISOString();
  const result = await session({ system: SYSTEM, user: 'daily review', tools, handle });
  await crm.close();
  const revised = fs.readFileSync(programPath, 'utf8');
  fs.writeFileSync(
    out,
    `${JSON.stringify({ started, system: SYSTEM, user: 'daily review', tools: tools.map((t) => ({ name: t.name, description: t.description })), prices: PRICES, original, revised, changed: revised !== original, ...result }, null, 1)}\n`,
  );
  console.log(`review: ${result.modelCalls} model call(s), $${result.costUsd.toFixed(4)}, ${result.ms} ms, stop ${result.stopReason}, program ${revised !== original ? 'changed' : 'unchanged'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
