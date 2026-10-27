// node signin.cjs <lf> <module>[:<declared>] <credential> [<field>=<value>]...: `lf
// credential add --headless` (`--credential <declared>` for a module that
// declares several), with the browser's part played against the fake OAuth
// provider (the fake consents at once and redirects back with a code, which
// is pasted to lf). A credential field lf asks for (`Label (field): `) is
// answered from the arguments, or left empty when they do not name it.
const { spawn } = require('child_process');

const [lf, target, name, ...pairs] = process.argv.slice(2);
const [mod, declared] = target.split(':');
const answers = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
const child = spawn(lf, ['credential', 'add', '--module', mod, name, ...(declared ? ['--credential', declared] : []), '--headless'], { stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
let read = 0;
let pasted = false;
child.stdout.on('data', async (chunk) => {
  out += chunk;
  const fresh = out.slice(read);
  const field = /\((\w+)\)(?: \[optional\])?: $/.exec(fresh)?.[1];
  if (field !== undefined) {
    read = out.length;
    child.stdin.write(`${answers[field] ?? ''}\n`);
    return;
  }
  const url = /(http\S+\/oauth\/authorize\?\S+)/.exec(out)?.[1];
  if (url === undefined || pasted || !/paste the URL/.test(out)) return;
  pasted = true;
  read = out.length;
  const back = (await fetch(url, { redirect: 'manual' })).headers.get('location');
  child.stdin.write(`${back}\n`);
});
const giveUp = setTimeout(() => {
  console.error(`lf credential add did not finish:\n${out}`);
  child.kill();
}, 60_000);
child.on('exit', (code) => {
  clearTimeout(giveUp);
  process.stdout.write(out.replace(/[?&](code|state|code_challenge)=[^&\s]*/g, ''));
  process.exit(code ?? 1);
});
