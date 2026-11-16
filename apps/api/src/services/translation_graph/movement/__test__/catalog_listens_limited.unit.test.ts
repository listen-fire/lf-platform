// 0.16: Slack's manifest says which release first let a listen limit its
// senders, and its sender's address is a branded claim, not plain text.

import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';
import { SLACK_EMAIL_CLAIM } from '@listen-fire/slack';

import { staticCatalogFromManifests, staticCatalogSnapshot } from '../catalog';

describe('a Slack listen on 0.16', () => {
  it('a_slack_listen_on_0_16_sees_the_branded_user_email', () => {
    expect(staticCatalogFromManifests().adapter('slack')?.listensLimitedBefore).toBe('0.16.0');
    expect(staticCatalogSnapshot().adapters.slack?.listensLimitedBefore).toBe('0.16.0');

    const { schema } = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'slack',
      entries: [{ typeId: 'slack:message', displayName: 'Message', collectionName: 'Messages', writable: false, readable: true }],
      descriptors: new Map([
        [
          'slack:message',
          {
            typeId: 'slack:message',
            displayName: 'Message',
            fields: [
              { fieldId: 'user_email', displayName: 'User Email', kind: 'string', brands: [SLACK_EMAIL_CLAIM], mayBeAbsent: true, writable: false, required: false },
            ],
            references: [],
          },
        ],
      ]),
    });
    expect(schema.positions.Message?.properties['User Email']).toEqual({
      kind: 'maybeAbsent',
      of: { kind: 'branded', of: 'text', brands: ['claim:email/address'] },
    });
  });
});
