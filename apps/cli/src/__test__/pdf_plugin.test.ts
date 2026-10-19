// `pdf.render(text)` in lf: `@lf/pdf` served by serve-module as a plugin
// external, called by position, its PDF stored as one of the run's documents
// and written to the CRM's file field, and the warning for a character the
// default writer cannot draw on the run's trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crmCompanies, lf, project } from './example';

const PDF = resolve(__dirname, '../../../../modules/pdf');

function pdfProject(body: string): string {
  const dir = project();
  mkdirSync(join(dir, 'externals/pdf'));
  writeFileSync(join(dir, 'externals/pdf/lf-external.yaml'), `name: pdf\nkind: plugin\nmodule: ${JSON.stringify(PDF)}\n`);
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/report.mvt'),
    `import { acme_crm } from adapters
import { \`@lf/pdf\` as pdf } from plugins
import { acme } from credentials

crm = connect acme_crm using acme

function report(company: <crm-[:Company]->>) {
  doc = ${body}
  write crm-[:Company]-> { Name: "Report for \${company.Name}", Report: doc }
}

listen to crm { events: ["company.created"] } fire report
`,
  );
  return dir;
}

/** Every stored document of the run, with its bytes. */
function storedPdfs(dir: string): string[] {
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(folder, entry.name));
      else if (entry.name.endsWith('.pdf')) found.push(readFileSync(join(folder, entry.name), 'latin1'));
    }
  };
  walk(join(dir, '.lf/files'));
  return found;
}

function runTrace(dir: string): Array<Record<string, unknown>> {
  const listed = lf(dir, 'runs').out.trim().split('\n')[0] ?? '';
  const shown = JSON.parse(lf(dir, 'runs', 'show', listed.split(' ')[0] ?? '').out) as { run?: { trace?: Array<Record<string, unknown>> } };
  return shown.run?.trace ?? [];
}

test('@lf/pdf as a process: pdf.render stores a PDF, written to the file field, with no warning for Latin-1', () => {
  const dir = pdfProject('pdf.render("Quarterly update\\ncafé", { pageSize: "letter" })');
  assert.equal(lf(dir, 'check').code, 0, lf(dir, 'check').out);
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(crmCompanies(dir).map((c) => c.fields.Name), ['Report for Vireo Robotics']);
  const [pdf] = storedPdfs(dir);
  assert.ok(pdf?.startsWith('%PDF-1.4'));
  assert.ok(pdf.includes('/MediaBox [0 0 612.00 792.00]'));
  assert.ok(pdf.includes('(Quarterly update) Tj'));
  assert.deepEqual(runTrace(dir).filter((e) => e.kind === 'warning'), []);
});

test('@lf/pdf warns on the run, naming the module, when a character prints as "?"', () => {
  const dir = pdfProject('pdf.render("Vireo 東京")');
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.ok(storedPdfs(dir)[0]?.includes('(Vireo ??) Tj'));
  const warnings = runTrace(dir).filter((e) => e.kind === 'warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.code, 'MOVENG_PLUGIN_WARNING');
  assert.match(String(warnings[0]?.message), /@lf\/pdf.*東 京.*Unicode PDF module/s);
});

test('File.from(…, "pdf") is refused by lf check, with the plugin call as the fix', () => {
  const dir = project();
  writeFileSync(
    join(dir, 'movements/companies.mvt'),
    readFileSync(join(dir, 'movements/companies.mvt'), 'utf8').replace(
      'write crm-[:Company]-> { Name: "Welcome ${company.Name}" }',
      'write crm-[:Company]-> { Name: "Welcome ${company.Name}", Report: File.from("x", "pdf") }',
    ),
  );
  const check = lf(dir, 'check');
  assert.notEqual(check.code, 0);
  assert.match(check.out, /MOV_V5_SPELLING.*@lf\/pdf.*pdf\.render\(text\)/s);
});
