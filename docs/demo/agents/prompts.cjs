// What the agents in the comparison are told, in one place, so the JavaScript
// and listen-fire options are told the same things in the same words wherever
// the two can be the same.
//
// Since 2026-11-03 (Henry: "listen-fire thrives in chaos") every system prompt
// is a small, general one, as a platform of its kind would give any task: it
// says what the platform is and how its automations are triggered, never what
// this task's systems look like. The user's request (with the retry email it
// needs) is the first user message, the same words for every option. Shapes
// are discovered, not given: every option has the same web search over the
// vendors' documentation (web.cjs); listen-fire also has its own catalog,
// handbook, example lookup and checker.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const read = (f) => fs.readFileSync(path.join(__dirname, 'programs', f), 'utf8').trim();

const retryEmail = read('retry_email.txt');
// The user's request, whole: what they asked for and the email it names.
const request = `${read('request.txt')}\n\nOur retry email:\n\n${retryEmail}`;
// What every option is told about working alone (programs/environment.txt).
const environment = read('environment.txt');
// The listen-fire reference every listen-fire agent is given (the authoring
// session and the woken one): the basic primer, and the `example` tool below.
// `lfReference` is recorded with the captures so a recording says which it had.
const cheatsheet = read('lf_primer_basic.md');
const lfReference = 'basic+lookup';
const exampleTool = {
  name: 'example',
  description: "Checked micro examples of listen-fire for what you describe, e.g. 'create or update by id'. Use it whenever you are unsure how to write something.",
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};
/** `<LF_BIN> example <query words>` in `cwd`: its stdout, and `(exit N)` after
 *  any stderr when it exits non-zero. `relative` makes the project's paths relative. */
function runExample(input, { cwd, relative = (t) => t }) {
  const words = String(input.query ?? '').split(/\s+/).filter(Boolean);
  const ran = spawnSync(process.env.LF_BIN || 'listen-fire', ['example', ...words], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const clean = (t) => relative(String(t ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).trimEnd();
  const stdout = clean(ran.stdout);
  if (ran.status === 0) return stdout;
  const stderr = clean(ran.stderr);
  return `${stdout}${stdout && stderr ? '\n' : ''}${stderr}\n(exit ${ran.status})`;
}

// What each platform says about a failure, in general: the same in substance.
const jsDelivery = 'A handler that throws is logged as failed for that event, and nothing runs it again by itself: the platform wakes you to decide what to do.';
const lfDelivery = 'A run that fails is kept as failed with its error (`listen-fire runs`), and nothing runs it again by itself: the host wakes you to decide what to do.';

const checkJs = 'Before you finish, test the handler and read what it did.';
const checkLf = 'Before you finish, run `listen-fire check` and a test run, and read what it did.';
const checkAgent = 'Check before you act.';
const quoted = (text) => text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');

/** The prompt a woken agent gets: the same for both options but for what
 *  kind of automation it maintains. */
function wakeSystem(kind) {
  const what =
    kind === 'js'
      ? 'Each automation is a JavaScript handler (handler.js) that a sandbox runs on every webhook its endpoint receives, with no model involved.'
      : 'Each automation is a listen-fire program (a .mvt file in this project), which `listen-fire serve` runs on every event it listens to, with no model involved.';
  return `You maintain the automations one of your users asked you for. ${what}

The user asked for this one:

${quoted(request)}

${kind === 'js' ? jsDelivery : lfDelivery}

The host has woken you, and says why in its message. Decide what to do: you may inspect what happened, fix the automation, deliberately ${kind === 'js' ? 'replay' : 're-run'} what failed, or tell the user. A ${kind === 'js' ? 'replay' : 'rerun'} runs the event again for real, with its side effects. Check your work before you finish.${kind === 'lf' ? `\n\nThe language, in short:\n\n${cheatsheet}` : ''}

${environment}

Finish with a short note on what you did.`;
}

module.exports = { request, retryEmail, environment, cheatsheet, lfReference, exampleTool, runExample, jsDelivery, lfDelivery, checkJs, checkLf, checkAgent, quoted, wakeSystem };
