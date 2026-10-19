// `pdf.render(text)` on the platform: the `@lf/pdf` module in process, its PDF
// stored under the team's key prefix and handed back as the call's file, and
// its warning carried to the run.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../document', () => ({
  DocumentService: { getById: jest.fn(async () => null) },
}));

const uploads: Array<{ bytes: Buffer; options: { filename: string; mimeType: string; keyPrefix?: string } }> = [];
jest.mock('../../../../adapters/registry', () => ({
  services: {
    document: {
      upload: async (stream: AsyncIterable<Buffer>, options: { filename: string; mimeType: string; keyPrefix?: string }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        uploads.push({ bytes: Buffer.concat(chunks), options });
        return { objectUri: `s3://bucket/${options.keyPrefix ?? ''}doc-${uploads.length}.pdf` };
      },
    },
  },
}));

import { NO_BUDGET_LIMIT } from 'movement-engine/lib/run_cost';
import { bundledPluginSpecs } from 'movement-engine/public/plugins';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { BUILTIN_MODULES } from '../../adapters/builtin_modules';
import { transformInvokerFor } from '../transform_invoker';

const TEAM = '11111111-1111-1111-1111-111111111111' as TeamId;
const invoker = transformInvokerFor(TEAM);
const render = (text: string, extra: Record<string, unknown> = {}) =>
  invoker.invoke({ plugin: 'render', config: { text, ...extra }, extractedContext: {}, budget: NO_BUDGET_LIMIT });

describe('pdf.render on the platform', () => {
  beforeEach(() => uploads.splice(0));

  it('is a catalog plugin of the @lf/pdf package, answering one file', () => {
    expect(BUILTIN_MODULES.render?.kind).toBe('plugin');
    const spec = bundledPluginSpecs().render;
    expect(spec?.package).toBe('@lf/pdf');
    expect(spec?.output).toEqual({ kind: 'value', type: 'file' });
    expect(spec?.requiredArgs).toEqual(['text']);
    expect(spec?.priced).toBe(false);
  });

  it('stores the PDF under the team and answers it as the call value', async () => {
    const answer = await render('Quarterly\nupdate');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.options).toMatchObject({ filename: 'movement-artifact.pdf', mimeType: 'application/pdf' });
    expect(uploads[0]?.options.keyPrefix).toContain(TEAM);
    expect(uploads[0]?.bytes.toString('latin1')).toContain('(Quarterly) Tj');
    expect(answer.data?.value).toMatchObject({ name: 'movement-artifact.pdf', contentType: 'application/pdf' });
    expect(answer.warnings).toBeUndefined();
  });

  it('warns on the run, naming the module, when it printed a "?"', async () => {
    const answer = await render('Tokyo 東京');
    expect(uploads[0]?.bytes.toString('latin1')).toContain('(Tokyo ??) Tj');
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings?.[0]).toContain('@lf/pdf');
    expect(answer.warnings?.[0]).toContain('A Unicode PDF module');
  });

  it('takes a page size', async () => {
    await render('x', { pageSize: 'letter' });
    expect(uploads[0]?.bytes.toString('latin1')).toContain('/MediaBox [0 0 612.00 792.00]');
  });
});
