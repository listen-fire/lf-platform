// A module's `ctx.files` on the platform: a file handed to it is read as the
// platform reads any file (`streamFileRef`), from the instance the run holds
// for its owner; `put` refuses.

import { Readable } from 'node:stream';

import type { Adapter } from 'movement-engine/public/adapter';
import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { withFileOwners } from 'movement-engine/public/files';
import { runWithPrincipal } from 'principal';
import { platformModuleFiles } from '../module_files';
import { exposeFile } from '../expose';

jest.mock('../expose', () => ({
  exposeFile: jest.fn(async () => ({ url: 'https://lf.test/api/files/blob/x', expiresAt: new Date() })),
}));

const files = platformModuleFiles({ teamId: 'team-1' as TeamId, module: '@lf/test' });

describe('platformModuleFiles', () => {
  it('reads a file the run’s own instance owns, as bytes', async () => {
    const asked: string[] = [];
    const owner = {
      resolveFileRef: async ({ ref }: { ref: { source?: unknown } }) => {
        asked.push(JSON.stringify(ref.source));
        return { stream: Readable.from([Buffer.from('owned '), Buffer.from('bytes')]), contentType: 'text/plain' };
      },
    } as unknown as Adapter;
    const bytes = await withFileOwners(
      (input) => (input.adapterType === 'google_drive' ? owner : undefined),
      () => files.read({ __brand: 'FileRef', source: { adapterType: 'google_drive', credentialId: 'cred-1', handle: 'f1' } }),
    );
    expect(Buffer.from(bytes).toString('utf8')).toBe('owned bytes');
    expect(asked).toEqual([JSON.stringify({ adapterType: 'google_drive', credentialId: 'cred-1', handle: 'f1' })]);
  });

  it('refuses a file with no way back to its bytes', async () => {
    await expect(files.read({ __brand: 'FileRef', name: 'loose.txt' })).rejects.toThrow("the file 'loose.txt' carries no handle to its bytes");
  });

  it('keeps nothing: put refuses, naming the module', async () => {
    await expect(files.put({ bytes: new Uint8Array() })).rejects.toThrow('module @lf/test: ctx.files.put has no store on the platform yet');
  });

  it('exposes a file as the install’s team, whatever identity is in scope', async () => {
    const owner = {
      resolveFileRef: async () => ({ stream: Readable.from([Buffer.from('deck')]), contentType: 'application/pdf' }),
    } as unknown as Adapter;
    const stranger = { teamId: 'team-stranger', access: 'write' as const, scopes: ['*'], pinnedTeamId: null };

    await runWithPrincipal(stranger, () =>
      withFileOwners(
        () => owner,
        () => files.expose({ __brand: 'FileRef', source: { adapterType: 'google_drive', credentialId: 'cred-1', handle: 'f1' } }),
      ),
    );

    expect(jest.mocked(exposeFile)).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1' }));
  });
});
