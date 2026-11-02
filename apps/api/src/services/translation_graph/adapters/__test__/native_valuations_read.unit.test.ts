// A Valuations record reads its fields off its flat row, the shape the REST
// API returns, with natural field names mapped to the row's columns
// (`Website` → `personal_website`). A change arrives on the record's
// `Changes` edge with `Current`/`Previous`, so no webhook envelope reaches a
// record position.


import type { TeamId } from '../../../../generated/kysely/core/Team';

import {
  NATIVE_VALUATIONS_ADAPTER_TYPE,
  createNativeValuationsAdapter,
} from '../native_valuations';
import { makeStablePosition } from 'engine-contracts/catalog';

const adapter = () =>
  createNativeValuationsAdapter({ teamId: 'team-1' as TeamId, credentialsId: 'cred-1' });

const NEWCO_ROW = {
  id: 'le-123',
  type: 'COMPANY',
  name: 'NewCo',
  personal_website: 'newconewconewco.com',
  description: 'a promising company',
};

const recordPosition = (data: unknown) =>
  makeStablePosition({
    adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
    recordType: 'Legal Entity',
    recordId: 'le-123',
    data,
  });

describe('NativeValuationsAdapter.getFieldValue', () => {
  it('reads a fetched record\'s flat row, Website from `personal_website`', async () => {
    const pos = recordPosition(NEWCO_ROW);
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Type' })).toBe('COMPANY');
    expect(await adapter().getFieldValue({ position: pos, fieldId: 'Website' })).toBe(
      'newconewconewco.com',
    );
  });
});
