// Which connection stands for a system in the graph explorer: the newest of its
// type that the asker may use. A newer one they may not use must not hide an
// older one they may.

import type { TeamId } from '../../../../generated/kysely/core/Team';

const mockState: { credentials: { id: string; name: string; type: string; created_at: Date }[]; remotes: { adapter_type: string; credentials_id: string | null }[] } = {
  credentials: [],
  remotes: [],
};

jest.mock('../../../../lib/kysely', () => ({
  ...jest.requireActual('../../../../lib/kysely'),
  getAutomationsQb: () => ({
    selectFrom: (table: string) => {
      const rows = () => (table === 'remote_adapter' ? mockState.remotes : mockState.credentials);
      const chain: object = new Proxy({}, { get: (_t, prop) => (prop === 'execute' ? async () => rows() : () => chain) });
      return chain;
    },
  }),
}));

import { enumerateSystems } from '../build';

const TEAM = '11111111-1111-4111-8111-111111111111' as TeamId;
const connection = (id: string, createdAt: number) => ({ id, name: id, type: 'ATTIO', created_at: new Date(createdAt) });

const keeping = (...ids: string[]) => ({
  usable: async <T extends { id: string }>(connections: T[]) => connections.filter((c) => ids.includes(c.id)),
});

const attio = async (options: Parameters<typeof enumerateSystems>[1]) =>
  (await enumerateSystems(TEAM, options)).find((system) => system.adapterType === 'attio');

beforeEach(() => {
  // As the query orders them: newest first.
  mockState.credentials = [connection('newest', 2), connection('older', 1)];
  mockState.remotes = [];
});

describe('enumerateSystems', () => {
  it('stands a system on the newest connection when the asker may use all of them', async () => {
    expect((await attio(keeping('older', 'newest')))?.credential).toMatchObject({ id: 'newest' });
  });

  it('stands it on an older connection the asker may use when the newest is one they may not', async () => {
    expect((await attio(keeping('older')))?.credential).toMatchObject({ id: 'older' });
  });

  it('leaves the system out when the asker may use none of its connections', async () => {
    expect(await attio(keeping())).toBeUndefined();
  });

  it('shows an installed module whose secret the asker may not use as having no connection', async () => {
    mockState.remotes = [{ adapter_type: 'acme_crm', credentials_id: 'newest' }];
    const systems = await enumerateSystems(TEAM, keeping('older'));
    expect(systems.find((system) => system.adapterType === 'acme_crm')).toMatchObject({ remote: true, credential: null });
  });
});
