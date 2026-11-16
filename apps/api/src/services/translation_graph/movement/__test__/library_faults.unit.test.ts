import { librariesInMessage, withoutLibraryFaults } from '../library_faults';
import { withoutLibraryLines } from '../save_access';

const PARSE = '"helpers" does not parse — Unexpected token (line 3, col 9) — fix the library file before importing from it';

describe('a library that does not parse', () => {
  it('is a library the message passes through', () => {
    expect(librariesInMessage(PARSE)).toEqual(['helpers']);
  });

  it('is found below a library that imports it', () => {
    expect(librariesInMessage(`"outer" line 1: ${PARSE.replace('helpers', 'inner')}`)).toEqual(['outer', 'inner']);
  });

  it('is stored as the library’s name alone', () => {
    const [stored] = withoutLibraryFaults([{ message: PARSE }]);
    expect(stored?.message).toContain('helpers');
    expect(stored?.message).not.toMatch(/Unexpected|line 3|fix the library/);
  });

  it('is rewritten in a failed run’s check lines', () => {
    const recorded = withoutLibraryLines(`IMPORT_FILE_INVALID (line 1): ${PARSE}`);
    expect(recorded).toContain('helpers');
    expect(recorded).not.toMatch(/Unexpected|line 3, col/);
  });
});
