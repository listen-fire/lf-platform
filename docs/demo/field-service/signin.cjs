// node signin.cjs <listen-fire> <module> <credential>: `listen-fire credential add --headless`,
// with the browser's part played against the fake OAuth provider (the fake
// consents at once and redirects back with a code, which is pasted to listen-fire).
const { spawn } = require('child_process');
const net = require('net');

const [lf, mod, name] = process.argv.slice(2);
// The redirect port is the credential's own choice, so each sign-in takes a free one.
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(String(port)));
  });
});

async function main() {
  const child = spawn(lf, ['credential', 'add', '--module', mod, name, '--headless', '--redirect-port', await freePort()], { stdio: ['pipe', 'pipe', 'inherit'] });
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
}

main();
