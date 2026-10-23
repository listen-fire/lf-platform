// A team's left-out movements are logged when the set changes, not on every
// listing (a watching lf lists about every 12 s).

import { logger } from 'movement-engine/public/log';

import { logLeftOutChange } from '../rows';

jest.mock('movement-engine/public/log', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
jest.mock('../../lf_secrets/rows', () => ({ servedCredentials: jest.fn() }));

const message = '[slots:movements] movements left out: they import a credential the secrets module does not serve';
const leave = (tenant: string, names: string[]) => logLeftOutChange({ tenant, reason: 'credentials', message, names });

describe('logLeftOutChange', () => {
  beforeEach(() => jest.clearAllMocks());

  it('two listings with the same left-out set log once, whatever the order of names', () => {
    leave('team-a', ['b', 'a']);
    leave('team-a', ['a', 'b']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(message, { count: 2, names: ['a', 'b'] });
  });

  it('a changed set logs again', () => {
    leave('team-b', ['a']);
    leave('team-b', ['a', 'c']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('an emptied set logs the served line once, and an empty set from the start logs nothing', () => {
    leave('team-c', []);
    expect(logger.info).not.toHaveBeenCalled();
    leave('team-c', ['a']);
    leave('team-c', []);
    leave('team-c', []);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('teams are tracked apart', () => {
    leave('team-d', ['a']);
    leave('team-e', ['a']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
