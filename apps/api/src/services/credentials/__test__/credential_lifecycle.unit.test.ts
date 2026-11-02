import type { TeamId } from '../../../generated/kysely/core/Team';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

const mockRevoke = jest.fn();

jest.mock('../../translation_graph/adapters/native_valuations', () => ({
  nativeValuationsCredsParser: { parse: (d: unknown) => d },
}));

jest.mock('../../api_key', () => ({
  ApiKeyService: { revoke: (...args: unknown[]) => mockRevoke(...args) },
}));

import { credentialLifecycle } from '../credential_lifecycle';

const teamId = 'team-1' as TeamId;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('credentialLifecycle', () => {
  it('returns undefined for a type with no lifecycle concern', () => {
    expect(credentialLifecycle(ExternalServiceType.GOOGLE)).toBeUndefined();
    expect(credentialLifecycle(ExternalServiceType.SLACK)).toBeUndefined();
    expect(credentialLifecycle(ExternalServiceType.ATTIO)).toBeUndefined();
  });

  describe('Listen-Fire Valuations', () => {
    const lc = () => {
      const l = credentialLifecycle(ExternalServiceType.NATIVE_VALUATIONS);
      if (!l) throw new Error('expected Valuations lifecycle');
      return l;
    };

    it('onDelete revokes the minted api-key', async () => {
      await lc().onDelete({ credentials: { apiKey: 'k', apiKeyId: 'key_1' }, teamId });
      expect(mockRevoke).toHaveBeenCalledWith('key_1');
    });

    it('onDelete is a no-op for a manually-wired key with no apiKeyId', async () => {
      await lc().onDelete({ credentials: { apiKey: 'k' }, teamId });
      expect(mockRevoke).not.toHaveBeenCalled();
    });
  });
});
