// What a firing's source module says of it: its echo suppression. No module on
// the 0.12 line answers `didWeAuthor` today, so a stand-in does.

const mockAdapter: { didWeAuthor?: () => Promise<boolean> } = {};
jest.mock('../lane/modules', () => ({ moduleTable: () => ({ resolve: async () => mockAdapter }) }));
jest.mock('../lane/listen_manifests', () => ({ manifestOf: () => undefined }));

import { gateFiring } from '../lane/listen';

const warn = jest.fn();
const modules = { log: { warn } } as never;
const gate = (config: unknown) =>
  gateFiring({ teamId: 't', adapterType: 'x', credentialsId: null, config, event: { pipelineInputId: 'trigger:a', adapterType: 'x', triggerType: 'webhook', payload: {} } }, modules);

describe('suppress_self under 0.12', () => {
  beforeEach(() => warn.mockClear());

  it('drops a change the module says is its own write', async () => {
    mockAdapter.didWeAuthor = async () => true;
    expect(await gate({ suppress_self: true })).toMatchObject({ kind: 'suppress' });
  });

  it('fires what it says is not, and asks nothing when the listen did not opt in', async () => {
    mockAdapter.didWeAuthor = async () => false;
    expect(await gate({ suppress_self: true })).toEqual({ kind: 'proceed' });
    mockAdapter.didWeAuthor = async () => {
      throw new Error('asked');
    };
    expect(await gate({})).toEqual({ kind: 'proceed' });
  });

  it('fires, loudly, when the check fails or the module cannot tell', async () => {
    mockAdapter.didWeAuthor = async () => {
      throw new Error('down');
    };
    expect(await gate({ suppress_self: true })).toEqual({ kind: 'proceed' });
    delete mockAdapter.didWeAuthor;
    expect(await gate({ suppress_self: true })).toEqual({ kind: 'proceed' });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
