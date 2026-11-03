// node summarize.cjs <work dir>: every attempt's cost, grade and check rounds,
// then each task and arm's means. An error round is an lf_check whose
// listen-fire exited non-zero; the codes are every diagnostic code printed by
// lf_check and test_run.
const fs = require('fs');
const path = require('path');

const work = process.argv[2];
const dir = path.join(work, 'attempts');
const rows = [];
for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
  const [task, arm, k] = name.split('-');
  const read = (f) => (fs.existsSync(path.join(dir, name, f)) ? JSON.parse(fs.readFileSync(path.join(dir, name, f), 'utf8')) : null);
  const attempt = read('attempt.json');
  const grade = read('grade.json');
  const tools = (attempt?.steps ?? []).filter((s) => s.role === 'tool');
  const checks = tools.filter((s) => s.name === 'lf_check');
  const exitOf = (s) => Number(/\(exit (-?\d+|null)\)\s*$/.exec(String(s.output))?.[1] ?? NaN);
  const codes = {};
  for (const s of tools.filter((s) => s.name === 'lf_check' || s.name === 'test_run')) {
    for (const code of String(s.output).match(/\b(?:MOV|MOVENG|LF)_[A-Z0-9_]+\b/g) ?? []) codes[code] = (codes[code] ?? 0) + 1;
  }
  const calls = {};
  for (const s of tools) calls[s.name] = (calls[s.name] ?? 0) + 1;
  rows.push({
    task,
    arm,
    k: Number(k),
    costUsd: attempt?.costUsd ?? null,
    modelCalls: attempt?.modelCalls ?? null,
    stopReason: attempt?.stopReason ?? null,
    pass: grade?.pass ?? false,
    failed: (grade?.checks ?? []).filter((c) => !c.ok).map((c) => c.name),
    checkRuns: checks.length,
    errorRounds: checks.filter((s) => exitOf(s) !== 0).length,
    testRuns: tools.filter((s) => s.name === 'test_run').length,
    testRunsFailed: tools.filter((s) => s.name === 'test_run' && (exitOf(s) !== 0 || /\bfailed\b/.test(String(s.output)))).length,
    codes,
    calls,
  });
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const groups = {};
for (const r of rows) (groups[`${r.task}/${r.arm}`] ??= []).push(r);
const summary = Object.entries(groups).map(([key, rs]) => {
  const codes = {};
  for (const r of rs) for (const [c, n] of Object.entries(r.codes)) codes[c] = (codes[c] ?? 0) + n;
  const costs = rs.map((r) => r.costUsd).filter((c) => c !== null);
  return {
    key,
    attempts: rs.length,
    meanCostUsd: mean(costs),
    correct: rs.filter((r) => r.pass).length,
    meanErrorRounds: mean(rs.map((r) => r.errorRounds)),
    meanModelCalls: mean(rs.map((r) => r.modelCalls ?? 0)),
    codes,
  };
});
fs.writeFileSync(path.join(work, 'summary.json'), `${JSON.stringify({ rows, summary }, null, 1)}\n`);
for (const r of rows) console.log(`${r.task}/${r.arm}#${r.k}: ${r.pass ? 'PASS' : 'FAIL'} $${(r.costUsd ?? 0).toFixed(4)} calls=${r.modelCalls} checks=${r.checkRuns} errorRounds=${r.errorRounds} testRuns=${r.testRuns}(${r.testRunsFailed} failed) codes=${JSON.stringify(r.codes)}${r.pass ? '' : ` failed=${JSON.stringify(r.failed)}`}`);
for (const s of summary) console.log(`${s.key}: n=${s.attempts} mean $${(s.meanCostUsd ?? 0).toFixed(4)} correct ${s.correct}/${s.attempts} meanErrorRounds=${s.meanErrorRounds?.toFixed(2)} meanCalls=${s.meanModelCalls?.toFixed(1)} codes=${JSON.stringify(s.codes)}`);
