// The agent woken when an automation needs it: a run failed, or (listen-fire)
// the host's periodic `lf check` found new errors. One real model session (the
// same model as every other agent here), told the same things for both options
// (prompts.cjs wakeSystem) and why the host woke it. Its tools:
//
//   both        tell_user          a message to the user (recorded, not sent)
//   js          read_handler, write_handler (the live handler.js),
//               test_handler       a dry run of a stored event (CRM real, email
//                                  and Slack recorded, kv empty)
//               sandbox_log        the sandbox's runs of an event
//               replay             run a stored event through the live handler,
//                                  for real
//               crm_list_tools     the CRM's tools, as the sandbox's client lists them
//                                  (or crm_api_reference, its REST API's reference)
//   lf          read_program, write_program (the live program), lf_check,
//               lf_runs, lf_runs_show, lf_deliveries,
//               test_run           a dry run of a run's event (`lf run --event … --dry-run`)
//               lf_rerun           `lf runs rerun <run-id> [--force]`: the failed run
//                                  again, now, as its next attempt (refused when
//                                  the failed attempt committed writes, unless
//                                  force, which makes them again)
//               describe_systems, handbook_search, handbook_read
//
// wake() answers the session (every block, tool call, usage, cost) with what it
// did: replays (js) or reruns (lf), messages to the user, and whether it
// changed the automation.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { session, PRICES } = require('./agent_tools.cjs');
const { wakeSystem } = require('./prompts.cjs');

function lfRunner(project) {
  const real = fs.realpathSync(project);
  const relative = (t) => t.split(`${real}/`).join('').split(`${project}/`).join('').split(real).join('.').split(project).join('.');
  return (args) => {
    const ran = spawnSync(process.env.LF_BIN || 'lf', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
    return `${relative(`${ran.stdout ?? ''}${ran.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).trimEnd()}\n(exit ${ran.status})`;
  };
}

async function wake({ kind, reason, js, lf }) {
  const actions = { replays: [], reruns: [], toldUser: [], wrote: 0 };
  const tell = { name: 'tell_user', description: 'Send your user a message (they read it later).', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } };
  let tools;
  let handle;
  let before;
  let file;
  if (kind === 'js') {
    file = js.handlerFile;
    before = fs.readFileSync(file, 'utf8');
    const stored = () => fs.readFileSync(js.storeFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event);
    tools = [
      { name: 'read_handler', description: 'handler.js as it stands (live).', input_schema: { type: 'object', properties: {} } },
      { name: 'write_handler', description: 'Replace the live handler.js with this source, whole. The next event runs it.', input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
      { name: 'test_handler', description: 'Run handler.js once on a stored event, as a dry run: CRM calls are real; email.send and slack.post are recorded and not sent; kv starts empty.', input_schema: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] } },
      { name: 'sandbox_log', description: "The sandbox's runs of an event: what each returned or threw, its log, its CRM calls, what it sent.", input_schema: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] } },
      { name: 'replay', description: 'Run a stored event through the live handler now, for real (its sends happen).', input_schema: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] } },
      js.dry.discovery.tool,
      tell,
    ];
    handle = async (name, input) => {
      switch (name) {
        case 'read_handler':
          return fs.readFileSync(file, 'utf8');
        case 'write_handler':
          fs.writeFileSync(file, String(input.source));
          actions.wrote += 1;
          return `wrote handler.js (${String(input.source).split('\n').length} lines)`;
        case 'test_handler': {
          const event = stored().find((e) => e.id === input.event_id);
          if (!event) throw new Error(`no stored event ${input.event_id}`);
          return JSON.stringify(await js.dry.run(fs.readFileSync(file, 'utf8'), event), null, 1);
        }
        case 'sandbox_log':
          return JSON.stringify(fs.readFileSync(js.logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.eventId === input.event_id), null, 1);
        case 'replay': {
          const answer = await fetch(`${js.receiver}/replay`, { method: 'POST', body: JSON.stringify({ eventId: input.event_id }) });
          const text = await answer.text();
          actions.replays.push({ eventId: input.event_id, answer: text.slice(0, 2000) });
          return text;
        }
        case js.dry.discovery.tool.name:
          return js.dry.discovery.run();
        case 'tell_user':
          actions.toldUser.push(String(input.message));
          return 'sent';
        default:
          throw new Error(`no tool ${name}`);
      }
    };
  } else {
    const run = lfRunner(lf.project);
    file = path.join(lf.project, lf.program);
    before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    tools = [
      { name: 'read_program', description: `${lf.program} as it stands (live).`, input_schema: { type: 'object', properties: {} } },
      { name: 'write_program', description: `Replace the live ${lf.program} with this source, whole. The next run uses it if it checks clean.`, input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
      { name: 'lf_check', description: 'Run `lf check`.', input_schema: { type: 'object', properties: {} } },
      { name: 'lf_runs', description: 'Run `lf runs`: the runs, most recent first.', input_schema: { type: 'object', properties: {} } },
      { name: 'lf_runs_show', description: 'Run `lf runs show <run-id>`.', input_schema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } },
      { name: 'lf_deliveries', description: 'Run `lf deliveries`: the deliveries kept, most recent first.', input_schema: { type: 'object', properties: {} } },
      { name: 'test_run', description: "A dry run of a run's event against the program as it stands: `lf run --event … --dry-run` (reads made, writes shown, not made).", input_schema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } },
      {
        name: 'lf_rerun',
        description:
          'Run `lf runs rerun <run-id>`: a failed run is run again now, for real, as its next attempt, on its own event and with the program as it stands, from the start. lf refuses when the failed attempt already committed writes, and lists them. force: true adds `--force`, which reruns it anyway and makes those writes again.',
        input_schema: { type: 'object', properties: { run_id: { type: 'string' }, force: { type: 'boolean' } }, required: ['run_id'] },
      },
      { name: 'describe_systems', description: 'Every system this project is connected to, as lf describes it (`lf catalog`).', input_schema: { type: 'object', properties: {} } },
      { name: 'handbook_search', description: "Search the language's handbook.", input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'handbook_read', description: 'Read the handbook: "index", a chapter, or chapter#section.', input_schema: { type: 'object', properties: { route: { type: 'string' } }, required: ['route'] } },
      tell,
    ];
    handle = async (name, input) => {
      switch (name) {
        case 'read_program':
          return fs.readFileSync(file, 'utf8');
        case 'write_program':
          fs.writeFileSync(file, String(input.source));
          actions.wrote += 1;
          return `wrote ${lf.program} (${String(input.source).split('\n').length} lines)`;
        case 'lf_check':
          return run(['check']);
        case 'lf_runs':
          return run(['runs']);
        case 'lf_runs_show':
          return run(['runs', 'show', String(input.run_id)]);
        case 'lf_deliveries':
          return run(['deliveries']);
        case 'test_run': {
          // The run's event as its delivery keeps it (external, credential,
          // event: what the door made of it, its type included).
          const json = (args) => JSON.parse(spawnSync(process.env.LF_BIN || 'lf', [...args, '--json'], { cwd: lf.project, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout);
          const { deliveryId } = json(['runs', 'show', String(input.run_id)]).run;
          const kept = [];
          (function find(x) {
            if (Array.isArray(x)) x.forEach(find);
            else if (x && typeof x === 'object') (typeof x.external === 'string' && x.event ? kept.push(x) : Object.values(x).forEach(find));
          })(json(['deliveries', 'show', deliveryId]));
          if (kept.length !== 1) return `run ${input.run_id}'s delivery ${deliveryId} keeps ${kept.length} events; test_run takes a run whose delivery keeps one`;
          const f = path.join(lf.scratch, `test_${input.run_id}.json`);
          fs.writeFileSync(f, JSON.stringify({ external: kept[0].external, credential: kept[0].credential, event: kept[0].event }));
          return run(['run', '--event', f, '--dry-run']);
        }
        case 'lf_rerun': {
          const force = input.force === true;
          const output = run(['runs', 'rerun', String(input.run_id), ...(force ? ['--force'] : [])]);
          actions.reruns.push({ runId: String(input.run_id), force, output });
          return output;
        }
        case 'describe_systems':
          return lf.describe();
        case 'handbook_search':
          return lf.handbook.search(String(input.query));
        case 'handbook_read':
          return String(input.route) === 'index' ? lf.handbook.index() : lf.handbook.read(String(input.route));
        case 'tell_user':
          actions.toldUser.push(String(input.message));
          return 'sent';
        default:
          throw new Error(`no tool ${name}`);
      }
    };
  }
  const system = wakeSystem(kind);
  const result = await session({ system, user: reason, tools, handle, maxCalls: 40 });
  const after = fs.readFileSync(file, 'utf8');
  return { reason, system, prices: PRICES, ...result, actions, changed: after !== before, before, after };
}

module.exports = { wake };
