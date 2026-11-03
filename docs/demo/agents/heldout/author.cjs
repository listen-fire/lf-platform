// node author.cjs <arm> <task> <project> <describe_systems file> <example run file> <out json>
//
// ../author_lf.cjs (adopt-0.13@0bfa2400) with the smallest change for a
// held-out task: the SYSTEM prompt's scenario parts (the connections, the
// retry email, the example Stripe event, how Stripe's deliveries arrive)
// become the task's, and everything generic is kept word for word. The arm
// decides only what it defines:
//
//   new  listen-fire main@d78f064454 (LF_BIN), the cheat sheet as committed at
//        adopt-0.13@0bfa2400, describe_systems as `listen-fire catalog`'s
//        text, no builder skill (author_lf.cjs as it is now).
//   old  listen-fire v0.14.2 (LF_BIN), the cheat sheet and the
//        listen-fire-builder skill as they were before adopt-0.13@5017c2df,
//        describe_systems as `listen-fire catalog`'s JSON over a scratch
//        program connecting every credential, lf_catalog described as JSON,
//        and the handbook's front page as v0.14.2 had it.
//   lookup  new in every way but two: the cheat sheet's place holds
//        ../programs/lf_primer_basic.md (snapshotted to lookup_arm/), and one
//        more tool, `example`, runs `<LF_BIN> example <words>`.
//   primer  new in every way but one: the cheat sheet's place holds the
//        primer (../programs/lf_primer.md, copied to primer_arm/ by run.sh
//        when its run starts).
//
// The handbook is listen-fire's own (LF_SRC, the main checkout), with a
// `system:<module>` chapter for each module the task's project installed.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const { session, PRICES } = require('./agent_tools.cjs');

const [arm, task, project, describeFile, exampleRun, out] = process.argv.slice(2);
if (!['old', 'new', 'primer', 'lookup'].includes(arm) || !['t1', 't2', 't3', 't4'].includes(task)) throw new Error('usage: author.cjs <old|new|primer|lookup> <t1|t2|t3|t4> <project> <describe> <example run> <out>');
const LF_BIN = process.env.LF_BIN;
const LF_SRC = process.env.LF_SRC;
const HERE = __dirname;
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8').trim();

const TASKS = {
  t1: {
    dir: 'tasks/t1_members',
    program: 'movements/members.mvt',
    modules: [
      ['airtable', 'AIRTABLE_MANIFEST'],
      ['telegram', 'TELEGRAM_MANIFEST'],
    ],
    connections: `- tg_bot: the community's Telegram bot, through its connector: messages people send the bot reach it. \`listen-fire serve\` prints its URL, and Telegram sends the bot's messages there.
- team_airtable: the team's Airtable, through its connector.`,
    // lfDelivery with Stripe's deliveries made Telegram's.
    delivery: `How events reach the program: \`listen-fire serve\` stores each Telegram delivery and acknowledges it (202) before it runs; a worker then runs it. A delivery of a message that has already been received is acknowledged as a duplicate and runs nothing.`,
    example: () => `An example of the update Telegram sends:\n\n\`\`\`json\n${fs.readFileSync(path.join(path.dirname(exampleRun), 'example.update.json'), 'utf8').trim()}\n\`\`\``,
    testWrites: 'Writes are made too, to the Airtable base, which is reset before the program goes live',
  },
  t2: {
    dir: 'tasks/t2_digest',
    program: 'movements/ticket_digest.mvt',
    modules: [['airtable', 'AIRTABLE_MANIFEST']],
    connections: `- team_airtable: the team's Airtable, through its connector.`,
    delivery: `How events reach the program: \`listen-fire serve\` fires each scheduled tick as it comes due; a worker then runs it. A tick that came due while nothing ran fires once when it runs again.`,
    example: () => `An example of the event the schedule fires (the test run fires the program on it):\n\n\`\`\`json\n${JSON.stringify(JSON.parse(fs.readFileSync(exampleRun, 'utf8')).event.arrivals[0].landing.fields, null, 2)}\n\`\`\``,
    testWrites: 'Writes are made too, to the Airtable base, which is reset before the program goes live',
  },
  t3: {
    dir: 'tasks/t3_enquiries',
    program: 'movements/enquiries.mvt',
    modules: [
      ['airtable', 'AIRTABLE_MANIFEST'],
      ['webhook', 'WEBHOOK_MANIFEST'],
    ],
    connections: `- site_form: the website's enquiry form, through the webhook connector: the form posts each enquiry to its URL as JSON (\`listen-fire serve\` prints the URL). The form does not sign its posts.
- team_airtable: the team's Airtable, through its connector.`,
    delivery: `How events reach the program: \`listen-fire serve\` stores each delivery the form posts and acknowledges it (202) before it runs; a worker then runs it. The form's posts carry no delivery id, so a post the form sends again is a new delivery and runs again.`,
    example: () => `An example of the JSON the form posts:\n\n\`\`\`json\n${fs.readFileSync(path.join(path.dirname(exampleRun), 'example.body.json'), 'utf8').trim()}\n\`\`\``,
    testWrites: 'Writes are made too, to the Airtable base, which is reset before the program goes live',
  },
  t4: {
    dir: 'tasks/t4_service',
    program: 'movements/service_jobs.mvt',
    modules: [['airtable', 'AIRTABLE_MANIFEST']],
    connections: `- team_airtable: the team's Airtable, through its connector.`,
    delivery: `How events reach the program: \`listen-fire serve\` fires each scheduled tick as it comes due; a worker then runs it. A tick that came due while nothing ran fires once when it runs again.`,
    example: () => `An example of the event the schedule fires (the test run fires the program on it):\n\n\`\`\`json\n${JSON.stringify(JSON.parse(fs.readFileSync(exampleRun, 'utf8')).event.arrivals[0].landing.fields, null, 2)}\n\`\`\``,
    testWrites: 'Writes are made too, to the Airtable base, which is reset before the program goes live',
  },
};
const T = TASKS[task];
const PROGRAM = T.program;
const request = read(`${T.dir}/request.txt`);
const environment = fs.readFileSync(path.join(HERE, '../programs/environment.txt'), 'utf8').trim();
const cheatsheet = read(arm === 'primer' ? 'primer_arm/lf_primer.md' : arm === 'lookup' ? 'lookup_arm/lf_primer_basic.md' : `${arm}_arm/lf_cheatsheet.md`);
// The rest of prompts.cjs's lfDelivery, after its Stripe sentences: generic.
const lfDeliveryRest = `A run that fails, by \`fail(…)\` or by a connected system refusing or failing a call, is kept as failed with its error (\`listen-fire runs\`), and nothing runs it again by itself: the host wakes you to decide what to do (inspect, fix, run it again with \`listen-fire runs rerun <run-id>\`, or tell the user). A rerun runs the failed run again as its next attempt, on its own event and with the program as the project holds it now (so a fix takes effect), from the start. lf refuses it when the failed attempt already committed writes, and lists them; \`--force\` reruns it anyway, making those writes again. The host also runs \`listen-fire check\` every 30 seconds and wakes you when it finds new errors.`;
const checkLf = 'Before you finish, check your work: run `listen-fire check`, and a test run (test_run) on the example event, and read what it did.';
const describeSystems = fs.readFileSync(describeFile, 'utf8').trim();
const programPath = path.join(project, PROGRAM);
const realProject = fs.realpathSync(project);

// The old arm's handbook front page is v0.14.2's: `./front_page` from the
// handbook package resolves to that copy (its one import is a type).
if (arm === 'old') {
  const handbookDir = path.join(LF_SRC, 'packages/handbook');
  const oldFront = path.join(HERE, 'old_arm/front_page.v0.14.2.ts');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if ((request === './front_page' || request === './front_page.ts') && parent?.filename && path.dirname(parent.filename) === handbookDir) return oldFront;
    return resolve.call(this, request, parent, ...rest);
  };
}

function loadHandbook() {
  Module.createRequire(path.join(LF_SRC, 'packages/module-kit/package.json'))('tsx/cjs');
  const hb = require(path.join(LF_SRC, 'packages/handbook/index.ts'));
  const chapters = { ...hb.CORE_CHAPTERS };
  for (const [name, exported] of T.modules) {
    const section = require(path.join(LF_SRC, 'modules', name, 'manifest.ts'))[exported].handbookSection;
    if (section) chapters[`system:${name}`] = { id: `system:${name}`, title: section.title, content: section.content };
  }
  const handbook = { intentIndex: hb.INTENT_INDEX, chapters };
  return {
    frontPage: () => hb.renderFrontPage(),
    index: () => hb.renderIndex(handbook),
    read: (route) => {
      const [id, section] = String(route).split('#');
      if (id === 'front') {
        if (!section) return hb.renderFrontPage();
        const r = hb.frontSection(section);
        return r.ok ? r.content : r.error;
      }
      const r = hb.readChapter(chapters, id, section || undefined);
      return r.ok ? r.content : r.error;
    },
    search: (query, kind) => JSON.stringify(hb.searchLanguage({ query, ...(kind ? { kind } : {}) }, chapters), null, 1),
  };
}
const handbook = loadHandbook();

function relative(text) {
  return text.split(`${realProject}/`).join('').split(`${project}/`).join('').split(realProject).join('.').split(project).join('.');
}

function lf(args) {
  const ran = spawnSync(LF_BIN, args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const printed = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return `${relative(printed).trimEnd()}\n(exit ${ran.status})`;
}

const credentials = lf(['credential', 'list']).replace(/\n\(exit \d+\)$/, '');

const SYSTEM = `You are an agent that sets up automations for your user. Automations are listen-fire programs: a .mvt file in this project, which \`listen-fire serve\` runs on every event it listens to, with no model involved.

When your user asks for one, write ${PROGRAM}. It must pass \`listen-fire check\`; it goes live under \`listen-fire serve\` once you finish. The project's connections are set up already (\`listen-fire credential list\`):

\`\`\`
${credentials}
\`\`\`

${T.connections}

${T.delivery} ${lfDeliveryRest}

${environment}

${T.example()}

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
    ...(arm === 'old' ? [{ name: 'read_skill', description: 'The listen-fire-builder skill: how to build automations with Listen-Fire for a user.', input_schema: { type: 'object', properties: {} } }] : []),
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
    arm === 'old'
      ? { name: 'lf_catalog', description: 'Run `listen-fire catalog`: the catalog the program is checked against, as JSON (each connection the program makes, its types and fields).', input_schema: { type: 'object', properties: {} } }
      : { name: 'lf_catalog', description: 'Run `listen-fire catalog`: the catalog the program is checked against (each connection the project holds, its types and fields).', input_schema: { type: 'object', properties: {} } },
    ...(arm === 'lookup'
      ? [
          {
            name: 'example',
            description: "Checked micro examples of listen-fire for what you describe, e.g. 'create or update by id'. Use it whenever you are unsure how to write something.",
            input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          },
        ]
      : []),
    { name: 'read_program', description: `${PROGRAM} as it stands.`, input_schema: { type: 'object', properties: {} } },
    { name: 'write_program', description: `Replace ${PROGRAM} with this source, whole.`, input_schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
    { name: 'lf_check', description: 'Run `listen-fire check`: every diagnostic the program has.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'test_run',
      description: `Run \`listen-fire run --event <the example event> --ephemeral\`: the program once on the example event, for real (listen-fire has no dry run of an event). Reads are made. ${T.testWrites}; the run is kept out of the project's run history.`,
      input_schema: { type: 'object', properties: {} },
    },
  ];
  if (!process.env.PROMPT_ONLY && fs.existsSync(programPath)) fs.rmSync(programPath);
  const handle = async (name, input) => {
    switch (name) {
      case 'describe_systems':
        return describeSystems;
      case 'read_skill':
        return read('old_arm/SKILL.md');
      case 'handbook_search':
        return handbook.search(String(input.query), input.kind);
      case 'handbook_read':
        return String(input.route) === 'index' ? handbook.index() : handbook.read(String(input.route));
      case 'lf_catalog':
        return lf(['catalog']);
      case 'example': {
        const words = String(input.query ?? '').split(/\s+/).filter(Boolean);
        const ran = spawnSync(LF_BIN, ['example', ...words], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
        const stdout = relative(`${ran.stdout ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).trimEnd();
        if (ran.status === 0) return stdout;
        const stderr = relative(`${ran.stderr ?? ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).trimEnd();
        return `${stdout}${stdout && stderr ? '\n' : ''}${stderr}\n(exit ${ran.status})`;
      }
      case 'read_program':
        return fs.existsSync(programPath) ? fs.readFileSync(programPath, 'utf8') : `(${PROGRAM} does not exist yet)`;
      case 'write_program':
        if (typeof input.source !== 'string' || input.source.trim() === '') throw new Error('source must be the whole program');
        fs.mkdirSync(path.dirname(programPath), { recursive: true });
        fs.writeFileSync(programPath, input.source);
        return `wrote ${PROGRAM} (${input.source.split('\n').length} lines)`;
      case 'lf_check':
        return lf(['check']);
      case 'test_run':
        return lf(['run', '--event', exampleRun, '--ephemeral']);
      default:
        throw new Error(`no tool ${name}`);
    }
  };
  // A rehearsal with no model call: the prompt, and what each tool answers
  // on the program already in place (run.sh's DRY puts the reference there).
  if (process.env.PROMPT_ONLY) {
    const probes = {};
    if (arm === 'lookup') {
      probes.example = await handle('example', { query: 'connect airtable base' });
      console.log(`example: ${probes.example.length} chars; first line: ${probes.example.split('\n')[0]}`);
      console.log(`example (no match): ${(await handle('example', { query: 'zzzqqq nonexistent' })).replace(/\n/g, ' | ').slice(0, 200)}`);
    }
    for (const probe of ['describe_systems', 'read_skill', 'lf_catalog', 'lf_check', 'test_run', 'handbook_read']) {
      if (!tools.some((t) => t.name === probe)) continue;
      probes[probe] = await handle(probe, { route: 'front#maybe-absent' });
      console.log(`${probe}: ${probes[probe].length} chars${/^\(exit \d+\)$/m.test(probes[probe]) ? `, ${/\(exit (\d+)\)\s*$/.exec(probes[probe])?.[0]}` : ''}`);
    }
    fs.writeFileSync(out, `${JSON.stringify({ arm, task, system: SYSTEM, user: request, tools, probes }, null, 1)}\n`);
    return;
  }
  const result = await session({ system: SYSTEM, user: request, tools, handle, maxCalls: 60 });
  const source = fs.existsSync(programPath) ? fs.readFileSync(programPath, 'utf8') : null;
  fs.writeFileSync(out, `${JSON.stringify({ arm, task, system: SYSTEM, user: request, tools: tools.map((t) => ({ name: t.name, description: t.description })), prices: PRICES, source, ...result }, null, 1)}\n`);
  console.log(`${task}/${arm} authoring: ${result.modelCalls} model call(s), $${result.costUsd.toFixed(4)}, ${result.ms} ms, stop ${result.stopReason}, program ${source ? `${source.split('\n').length} lines` : 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
