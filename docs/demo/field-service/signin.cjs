// node signin.cjs <lf> <module> <credential>: `lf credential add --headless`,
// with the browser's part played against the fake OAuth provider (the fake
// consents at once and redirects back with a code, which is pasted to lf).
const { spawn } = require('child_process');

const [lf, mod, name] = process.argv.slice(2);
const child = spawn(lf, ['credential', 'add', '--module', mod, name, '--headless'], { stdio: ['pipe', 'pipe', 'inherit'] });
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
