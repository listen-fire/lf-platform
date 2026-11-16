// A fault the checker found inside a library is told by the diagnostic's own
// field naming the library, never by how its message happens to be worded.

const mockRows = new Map<string, { id: string }>([['lib/finance', { id: 'automation-finance' }]]);
const mockReadable = new Set<string>();

jest.mock('../store', () => ({
  ...jest.requireActual('../store'),
  getMovementRowByName: jest.fn(async ({ name }: { name: string }) => mockRows.get(name) ?? null),
}));
jest.mock('../../../access/decide', () => ({
  ...jest.requireActual('../../../access/decide'),
  accessTo: jest.fn(async (_who: unknown, { target }: { target: { id: string } }) => mockReadable.has(target.id)),
}));

import type { Principal } from 'principal';

import { librariesOf, withoutLibraryFaults } from '../library_faults';
import { hideUnreadableLibraries } from '../save_access';

const reader: Principal = { kind: 'user', id: 'user-1' } as never;
const REWORDED = 'The tax rate is not a number (finance helper, third definition)';

describe('a diagnostic that names its library', () => {
  beforeEach(() => mockReadable.clear());

  it('is hidden from a reader without read on that library, whatever its message says', async () => {
    const [shown] = await hideUnreadableLibraries([{ code: 'X', message: REWORDED, file: 'lib/finance' }], {
      teamId: 'team-1',
      audience: { for: reader },
    });
    expect(shown?.message).toContain('"lib/finance"');
    expect(shown?.message).not.toContain('tax rate');
  });

  it('is shown to a reader with read on it', async () => {
    mockReadable.add('automation-finance');
    const [shown] = await hideUnreadableLibraries([{ code: 'X', message: REWORDED, file: 'lib/finance' }], {
      teamId: 'team-1',
      audience: { for: reader },
    });
    expect(shown?.message).toBe(REWORDED);
  });

  it('is stored as the library’s name alone, whatever its message says', () => {
    const [stored] = withoutLibraryFaults([{ message: REWORDED, file: 'lib/finance' }]);
    expect(stored?.message).toContain('lib/finance');
    expect(stored?.message).not.toContain('tax rate');
  });

  it('names the file first, then any deeper library only the text still shows', () => {
    expect(librariesOf({ message: `"lib/finance" line 2: "inner" does not parse`, file: 'lib/finance' })).toEqual(['lib/finance', 'inner']);
    expect(librariesOf({ message: REWORDED })).toEqual([]);
  });
});
