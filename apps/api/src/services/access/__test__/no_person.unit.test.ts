import { automationLists, automationWithNoPerson, connectionWithNoPerson } from '../no_person';

const team = { kind: 'team' } as const;
const anyone = { kind: 'anyone' } as const;

describe('what a thing is created with when no person is in the request', () => {
  it('lets the whole team use a connection', () => {
    expect(connectionWithNoPerson()).toEqual({ use: [team] });
  });

  it('lets the whole team read and write an automation, writing first', () => {
    const statements = automationWithNoPerson({ listens: [{ module: 'email', viaConnection: false }], runsOnLf: false });
    expect(statements.read).toEqual([team]);
    expect(statements.write).toEqual([team]);
    expect(automationLists(statements).map((list) => list.verb)).toEqual(['write', 'read', 'fire']);
  });

  it.each([
    ['Slack', [{ module: 'slack', viaConnection: true }], [team]],
    ['Slack, by its trigger kind', [{ module: 'SLACK', viaConnection: true }], [team]],
    ['WhatsApp on the shared number', [{ module: 'whatsapp', viaConnection: false }], [team]],
    ['WhatsApp on a number of its own', [{ module: 'whatsapp', viaConnection: true }], [anyone]],
    ['email', [{ module: 'email', viaConnection: false }], [anyone]],
    ['email, by its trigger kind', [{ module: 'CUSTOM_EMAIL', viaConnection: false }], [anyone]],
    ['a schedule', [{ module: 'cron', viaConnection: false }], [anyone]],
    ['any other module', [{ module: 'attio', viaConnection: true }], [anyone]],
    ['a file mixing them, which gets the narrowest', [{ module: 'email', viaConnection: false }, { module: 'slack', viaConnection: true }], [team]],
    ['a file with no listens', [], [team]],
  ])('fires an automation listening to %s as that module admits today', (_, listens, fire) => {
    expect(automationWithNoPerson({ listens, runsOnLf: false }).fire).toEqual(fire);
  });

  it('says anyone may fire on a team whose automations run on lf, whose door the platform does not judge', () => {
    expect(automationWithNoPerson({ listens: [{ module: 'slack', viaConnection: true }], runsOnLf: true }).fire).toEqual([anyone]);
  });
});
