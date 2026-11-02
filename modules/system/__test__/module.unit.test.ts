// The module's surface as a host describes it: one listenable root edge,
// `Events`, polled, narrowed by `Kind`, passing the engine's own describe
// check (the refusals listen-fire's describe makes), at adapter protocol 2.6.

import { adapterInProcess, noCredential, refusingFiles, refusingKv, type ModuleHost } from 'module-kit';
import { introspectAdapter } from 'movement-engine/public/embed';

import { SystemAdapter } from '../adapter';
import { systemModuleWith } from '../index';
import { SYSTEM_MANIFEST } from '../manifest';
import type { SystemRecords } from '../records';
import { SYSTEM_EVENT_KINDS } from '../types';

const NO_FACTS: SystemRecords = {
  failedRuns: async () => [],
  pausedRuns: async () => [],
  strandedWaits: async () => [],
  releases: async () => [],
  unjudgedArrivals: async () => [],
  webBaseUrl: async () => null,
};

describe('@lf/system surface', () => {
  it('passes the engine’s describe check: no retired key, every listenable declaration readable', async () => {
    const { schema, notes } = await introspectAdapter(new SystemAdapter(), SYSTEM_MANIFEST);
    expect(notes).toEqual([]);
    expect(schema).toBeDefined();
  });

  it('lists one listenable, polled root edge, Events, landing on Event', async () => {
    expect(await new SystemAdapter().listEntryPoints()).toEqual([
      expect.objectContaining({ collectionName: 'Events', typeId: 'Event', listenable: true, delivery: 'polled', identity: 'Event Id', readable: false, writable: false }),
    ]);
  });

  it('declares every kind, the two new ones among them, as a value of Kind', async () => {
    const event = await new SystemAdapter().describe('Event');
    const kind = event?.fields.find((field) => field.displayName === 'Kind');
    expect(kind?.enumValues).toEqual(SYSTEM_EVENT_KINDS.map((k) => k.name));
    expect(kind?.enumValues).toEqual(expect.arrayContaining(['Wait Lost Its Record', 'Arrival Not Judged']));
  });

  it('states adapter protocol 2.6, declares no method 0.13 retired, and polls by edge', async () => {
    const quiet = () => undefined;
    const host: ModuleHost = {
      tenant: 'team-1',
      credential: noCredential('@lf/system needs none'),
      log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
      files: refusingFiles('no files'),
      kv: refusingKv('no kv'),
      validateResults: true,
    };
    const loaded = adapterInProcess(systemModuleWith(() => NO_FACTS), host);
    expect(loaded.manifest.protocolMinor).toBe(6);
    expect(loaded.manifest.methods).not.toContain('listEventTypes');
    expect(await loaded.poll?.({ edge: 'Events' })).toEqual({ arrivals: [], cursor: expect.any(Object) });
  });
});
