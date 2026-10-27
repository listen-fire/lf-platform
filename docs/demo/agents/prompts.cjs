// What the agents in the comparison are told, in one place, so the JavaScript
// and listen-fire options are told the same things in the same words wherever
// the two can be the same.
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, 'programs', f), 'utf8').trim();

const request = read('request.txt');
const retryEmail = read('retry_email.txt');
const environment = read('environment.txt');
const cheatsheet = read('lf_cheatsheet.md');

// How each option's events reach it. The same in substance: stored and
// acknowledged before they run, a repeat delivered as Stripe does, a failure
// kept and not run again by itself, the agent woken to decide.
const jsDelivery = `How events reach the handler: the sandbox stores each webhook and acknowledges it (200) before it runs the handler, one event at a time. Stripe delivers each event at least once, and may deliver the same event more than once. A handler that throws is logged as failed for that event, and nothing runs it again by itself: the host wakes you to decide what to do (inspect, fix, replay it, or tell the user).`;

const lfDelivery = `How events reach the program: \`lf serve\` stores each Stripe delivery and acknowledges it (202) before it runs; a worker then runs it. A delivery whose Stripe event id has already been received is acknowledged as a duplicate and runs nothing. A run that fails, by \`fail(…)\` or by a connected system refusing or failing a call, is kept as failed with its error (\`lf runs\`), and nothing runs it again by itself: the host wakes you to decide what to do (inspect, fix, run it again with \`lf runs rerun <run-id>\`, or tell the user). A rerun runs the failed run again as its next attempt, on its own event and with the program as the project holds it now (so a fix takes effect), from the start. lf refuses it when the failed attempt already committed writes, and lists them; \`--force\` reruns it anyway, making those writes again. The host also runs \`lf check\` every 30 seconds and wakes you when it finds new errors.`;

const checkJs = 'Before you finish, check your work: test-run the handler on the example event and read what it did.';
const checkLf = 'Before you finish, check your work: run `lf check`, and a dry run (test_run) on the example event, and read what it did.';
const checkAgent = 'Check before you act: confirm what applies to this event before you send anything.';

/** The prompt a woken agent gets: the same for both options but for what
 *  kind of automation it maintains and how its events are delivered. */
function wakeSystem(kind) {
  const what =
    kind === 'js'
      ? 'Each automation is a JavaScript handler in a sandbox (handler.js), which the sandbox runs on every event, with no model involved.'
      : 'Each automation is a listen-fire program (a .mvt file in this project), which `lf serve` runs on every event, with no model involved.';
  return `You maintain the automations one of your users asked you for. ${what}

The user asked for this one:

> ${request}

Our retry email:

${retryEmail}

${kind === 'js' ? jsDelivery : lfDelivery}

The host has woken you, and says why in its message. Decide what to do: you may inspect what happened, fix the automation, deliberately ${kind === 'js' ? 'replay' : 're-run'} what failed, or tell the user. A ${kind === 'js' ? 'replay' : 'rerun'} runs the event again for real, with its side effects. Check your work before you finish.${kind === 'lf' ? `\n\nThe language, in short:\n\n${cheatsheet}` : ''}

${environment}

Finish with a short note on what you did.`;
}

module.exports = { request, retryEmail, environment, cheatsheet, jsDelivery, lfDelivery, checkJs, checkLf, checkAgent, wakeSystem };
