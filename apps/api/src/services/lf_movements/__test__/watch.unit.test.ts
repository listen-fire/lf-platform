// The two pure halves of the watch: what changed between two listings, and
// the channel a team's changes are announced on.

import { teamChannel } from '../team_changes';
import { listingChanges } from '../watch';

describe('listingChanges', () => {
  it('a version moved is changed, a path only after is added, a path only before is removed, in path order', () => {
    const before = [
      { path: 'a.mvt', version: '1' },
      { path: 'b.mvt', version: '1' },
      { path: 'lib/c.mvt', version: '1' },
    ];
    const after = [
      { path: 'a.mvt', version: '1' },
      { path: 'b.mvt', version: '2' },
      { path: 'd.mvt', version: '1' },
    ];
    expect(listingChanges(before, after)).toEqual([
      { kind: 'changed', path: 'b.mvt', version: '2' },
      { kind: 'added', path: 'd.mvt', version: '1' },
      { kind: 'removed', path: 'lib/c.mvt' },
    ]);
  });

  it('the same listing is no change', () => {
    const listing = [{ path: 'a.mvt', version: '1' }];
    expect(listingChanges(listing, [...listing])).toEqual([]);
  });
});

describe('teamChannel', () => {
  it("is the id's hex digits, lower case, as the trigger writes them", () => {
    expect(teamChannel('11111111-2222-3333-4444-5555555555AA')).toBe('lf_movements_111111112222333344445555555555aa');
  });

  it('refuses anything but a uuid, so a channel name is never built from free text', () => {
    expect(() => teamChannel('x"; LISTEN y')).toThrow('a team id is a uuid');
  });
});
