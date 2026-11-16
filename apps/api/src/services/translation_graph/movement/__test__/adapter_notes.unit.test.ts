import type { AdapterManifest } from 'movement-engine/public/adapter';

import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { deriveCapabilityNote, deriveIdentityNote } from '../adapter_notes';

function manifest(overrides: Partial<AdapterManifest>): AdapterManifest {
  return {
    adapterType: 'x',
    displayName: 'X',
    supportedTriggers: ['webhook'],
    methods: [],
    ...overrides,
  };
}

describe('deriveIdentityNote', () => {
  it('a credentialed system states runs-as only: who sets a listen off is its filter`s to say', () => {
    const note = deriveIdentityNote(
      manifest({ displayName: 'Slack', requiredCredentialType: ExternalServiceType.SLACK, listensLimitedBefore: '0.16.0', methods: ['createRecord'] }),
    );
    expect(note).toBe('It runs with the Slack account that connected it: whatever it writes acts as that account, not whoever set the run off.');
  });

  it('an intrinsic (no credential) has no identity note', () => {
    expect(deriveIdentityNote(manifest({ displayName: 'Knowledge Graph', methods: ['createRecord'] }))).toBeUndefined();
  });
});

describe('deriveCapabilityNote', () => {
  it('a system with no write methods is source-only', () => {
    expect(deriveCapabilityNote(manifest({ methods: [] }))).toContain('Source only');
  });

  it('create without update/delete is add-only', () => {
    const note = deriveCapabilityNote(manifest({ methods: ['createRecord'] }));
    expect(note).toContain('added here, not updated or deleted');
  });

  it('create+update without delete says no delete', () => {
    const note = deriveCapabilityNote(manifest({ methods: ['createRecord', 'updateRecord'] }));
    expect(note).toContain('added and updated, but not deleted');
  });

  it('a system with no triggers says so (a write/read target, not a source)', () => {
    const note = deriveCapabilityNote(manifest({ methods: ['createRecord'], supportedTriggers: [] }));
    expect(note).toContain('no event triggers');
  });

  it('full read/write with triggers has nothing limiting to say', () => {
    expect(
      deriveCapabilityNote(manifest({ methods: ['createRecord', 'updateRecord', 'deleteRecord'] })),
    ).toBeUndefined();
  });
});
