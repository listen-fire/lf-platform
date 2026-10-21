// The HubSpot-like provider and module of the Alice/Bob acceptance, for the
// tests of a host (lf's, the platform's). The provider is a standalone server
// the test starts itself, not a route of the fake-channels server; the module
// is a file for serve-module to serve.

import { resolve } from 'node:path';

export { startFakeHubSpot, type FakeHubSpot, type ProviderCall } from './src/hubspot/fake_hubspot';
export { dealCreatedEvent } from './src/hubspot/module';

/** The HubSpot-like module's file, as serve-module takes it. */
export const HUBSPOT_MODULE = resolve(__dirname, 'src/hubspot/module.ts');
