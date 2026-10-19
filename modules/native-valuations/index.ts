// `@lf/native-valuations`: the platform's own Valuations product, reached
// through its REST API, as a module. Platform-supplied: the API it calls is
// the platform's, so the platform hosts it in process and nothing outside the
// platform has a use for it; it is never published or served as a process.
// The host hands it the install's credential (an api-key, and where the API
// is: the platform fills its own address when the credential names none) and
// a fetch; the module opens the API from them on every call.

import { defineModule } from 'module-kit';

import { NativeValuationsAdapter } from './adapter';
import { moduleValuationsApi } from './credential';
import { NATIVE_VALUATIONS_MANIFEST } from './manifest';

export const nativeValuationsModule = defineModule({
  kind: 'adapter',
  name: '@lf/native-valuations',
  manifest: NATIVE_VALUATIONS_MANIFEST,
  // The stored payload the platform provisions: `{ apiKey, apiKeyId?, baseUrl? }`.
  credentials: [
    {
      name: 'native_valuations',
      kind: 'static',
      fields: [
        { name: 'apiKey', label: 'API key' },
        { name: 'apiKeyId', label: 'API key id', secret: false, optional: true },
        { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
      ],
    },
  ],
  // The platform's outbox signs each delivery as Attio does (bare hex
  // HMAC-SHA256 of the body, keyed with the secret minted at registration),
  // read through the same chain of headers the door has always read.
  inbound: {
    providerKey: 'native_valuations',
    scheme: 'attio',
    signatureHeaders: ['attio-signature', 'x-attio-signature', 'x-airtable-content-mac', 'x-webhook-signature'],
  },
  create: (ctx) => new NativeValuationsAdapter({ api: moduleValuationsApi(ctx), log: ctx.log }),
});

export default nativeValuationsModule;

export * from './adapter';
export * from './credential';
export * from './inbound';
export * from './manifest';
export * from './types';
export * from './webhook';
