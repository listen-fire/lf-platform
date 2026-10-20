// One of several processes counting up the same file kv by compare-and-set:
// `node count_up.cjs <dir> <times>`.
require('tsx/cjs');
const { fileKv } = require('../../file_kv.ts');

async function main() {
  const [dir, times] = process.argv.slice(2);
  const kv = fileKv(dir, 'team-a');
  for (let done = 0; done < Number(times); ) {
    const seen = await kv.get('count');
    if (await kv.compareAndSet('count', seen, (typeof seen === 'number' ? seen : 0) + 1)) done += 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
