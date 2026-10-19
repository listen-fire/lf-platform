// The Settings ("Create subscription") provider for Listen-Fire Valuations.
// Registration goes through the module's helpers (@lf/native-valuations), the
// same ones a movement's listen provisions with, over the API the stored
// credential opens. Deliveries are parsed by the adapter's
// `preprocessInbound`; their signature is checked by the door.

import type { WebhookProvider, WebhookRegistration } from './interface';

import {
  NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS,
  deregisterValuationsWebhook,
  registerValuationsWebhook,
} from '@listen-fire/native-valuations';
import { platformValuationsApi } from '../../translation_graph/adapters/native_valuations';

const nativeValuationsProvider: WebhookProvider = {
  // Valuations exposes /api/v1/valuations/webhooks for self-registration;
  // we hit it like any other 3rd-party provider so subscription create/delete
  // round-trips the real authentication + REST path. Lives in-process for
  // dev convenience but doesn't cheat past the public surface.
  canRegisterViaApi: true,

  defaultEventTypes: [...NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS],

  async registerSubscription(input): Promise<WebhookRegistration> {
    return registerValuationsWebhook(await platformValuationsApi(input.credentialsId), {
      targetUrl: input.targetUrl,
      eventTypes: input.eventTypes,
    });
  },

  async deregisterSubscription(input): Promise<void> {
    await deregisterValuationsWebhook(await platformValuationsApi(input.credentialsId), { externalId: input.externalId });
  },
};

export { nativeValuationsProvider };
