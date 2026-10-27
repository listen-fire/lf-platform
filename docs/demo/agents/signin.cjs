// node signin.cjs <lf> <module> <name> <declared credential> [answer…]:
// `lf credential add --headless`, with the browser's part played against the
// fake OAuth provider (the fake consents at once and redirects back with a
// code, which is pasted to lf). The answers go to the questions lf asks
// before signing in (a mailbox's address, optional fields left blank).
const { spawn } = require('child_process');

const [lf, mod, name, credential, ...answers] = process.argv.slice(2);
const child = spawn(lf, ['credential', 'add', '--module', mod, name, '--credential', credential, '--headless'], { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdin.write(answers.map((a) => `${a}\n`).join(''));
let out = '';
let answered = false;
child.stdout.on('data', async (chunk) => {
  out += chunk;
  const url = /(http\S+\/oauth\/authorize\?\S+)/.exec(out)?.[1];
  if (url === undefined || answered || !/paste the URL/.test(out)) return;
  answered = true;
  const back = (await fetch(url, { redirect: 'manual' })).headers.get('location');
  child.stdin.write(`${back}\n`);
});
child.on('exit', (code) => {
  process.stdout.write(out.replace(/[?&](code|state|code_challenge)=[^&\s]*/g, ''));
  process.exit(code ?? 1);
});
