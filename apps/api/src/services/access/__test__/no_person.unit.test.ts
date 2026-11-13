import { automationLists, automationWithNoPerson, connectionWithNoPerson } from '../no_person';

const team = { kind: 'team' } as const;

describe('what a thing is created with when no person is in the request', () => {
  it('lets the whole team use a connection', () => {
    expect(connectionWithNoPerson()).toEqual({ use: [team] });
  });

  it('creation states read and write for an automation and use for a connection, nothing else', () => {
    const statements = automationWithNoPerson();
    expect(statements).toEqual({ read: [team], write: [team] });
    expect(automationLists(statements)).toEqual([
      { verb: 'write', grantees: [team] },
      { verb: 'read', grantees: [team] },
    ]);
    expect(Object.keys(connectionWithNoPerson())).toEqual(['use']);
  });
});
