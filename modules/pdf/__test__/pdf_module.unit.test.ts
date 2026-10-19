// `@lf/pdf` as a module: its manifest, an invocation in process, and the same
// module served as a process over the protocol (the way lf runs it).

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from 'engine-contracts';
import { noCredential, pluginsInProcess, refusingFiles, refusingKv } from 'module-kit';

import { pdfModule } from '../index';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const inProcess = pluginsInProcess(pdfModule, {
  tenant: 't',
  credential: noCredential('none'),
  log: quiet,
  files: refusingFiles('none'),
  kv: refusingKv('none'),
  validateResults: true,
});
const render = (config: Record<string, unknown>) => inProcess.invoke({ name: 'render', config, extractedContext: {} });
const pdfText = (base64: string) => Buffer.from(base64, 'base64').toString('latin1');

describe('@lf/pdf', () => {
  it('declares one package with one plugin, render', () => {
    expect(pdfModule.name).toBe('@lf/pdf');
    expect(pdfModule.plugins.map((p) => p.signature.name)).toEqual(['render']);
  });

  it('answers the PDF as a file for the host to store', async () => {
    const answer = await render({ text: 'Quarterly update\nall good' });
    expect(answer.warnings).toBeUndefined();
    expect(answer.files?.value?.contentType).toBe('application/pdf');
    expect(pdfText(answer.files?.value?.base64 ?? '')).toContain('(Quarterly update) Tj');
  });

  it('warns, naming the module and that a Unicode module can replace it, when it printed "?"', async () => {
    const answer = await render({ text: 'Zürich 東京' });
    expect(pdfText(answer.files?.value?.base64 ?? '')).toContain('(Z\\374rich ??) Tj');
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings?.[0]).toContain('@lf/pdf');
    expect(answer.warnings?.[0]).toContain('東 京');
    expect(answer.warnings?.[0]).toContain('A Unicode PDF module');
  });

  it('takes a page size and a margin, and refuses ones it does not know', async () => {
    const letter = await render({ text: 'x', pageSize: 'letter', margin: 10 });
    expect(pdfText(letter.files?.value?.base64 ?? '')).toContain('/MediaBox [0 0 612.00 792.00]');
    await expect(render({ text: 'x', pageSize: 'a3' })).rejects.toThrow('pageSize is "a4" or "letter"');
    await expect(render({ text: 'x', margin: -1 })).rejects.toThrow('margin is a whole number of points');
  });

  it('served as a process, answers the same over the protocol', async () => {
    const serve = join(__dirname, '../../../packages/module-kit/bin/serve-module.cjs');
    const child = spawn(process.execPath, [serve, join(__dirname, '..')], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.on('data', (chunk: Buffer) => {
          const m = /listening (\d+)/.exec(String(chunk));
          if (m) resolve(Number(m[1]));
        });
      });
      const call = async (method: string, params: object) => {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, cacheScopeId: 'test', method, params }),
        });
        return res.json() as Promise<{ ok: boolean; result?: any; error?: unknown }>;
      };
      const manifest = await call('manifest', {});
      expect(manifest.ok).toBe(true);
      expect(manifest.result?.plugins?.package).toBe('@lf/pdf');
      const answer = await call('invokePlugin', { name: 'render', config: { text: 'over the wire 中' }, extractedContext: {} });
      expect(answer.ok).toBe(true);
      expect(pdfText(answer.result.files.value.base64)).toContain('(over the wire ?) Tj');
      expect(answer.result.warnings).toHaveLength(1);
    } finally {
      child.kill();
    }
  });
});
