// How `@lf/kg` reads the store's change envelope, and answers whether a change
// was its own automation's — no host, no store.

import { changeEventsOf, didWeAuthorChange } from '../events';
import { KG_INBOUND, kgManifest } from '../manifest';

const CONTEXT = {
  source: { type: 'structured_input', adapterType: 'kg', pipelineInputId: 'trigger:t-1' },
  occurredAt: '2026-10-19T10:00:00.000Z',
};

const envelope = (data: Record<string, unknown>) => ({
  event: 'record.updated',
  timestamp: '2026-10-19T10:00:01.000Z',
  data: {
    recordId: '00000000-0000-4000-8000-00000000c001',
    nodeTypeId: 'nt-company',
    changeKind: 'update',
    changedFields: ['pt-domains'],
    context: CONTEXT,
    ...data,
  },
});

describe('changeEventsOf', () => {
  it('reads one envelope as one event about the changed record', () => {
    const warn = jest.fn();
    expect(changeEventsOf(envelope({}), warn)).toEqual([
      {
        payload: envelope({}).data,
        eventType: 'record.updated',
        recordType: 'nt-company',
        externalId: '00000000-0000-4000-8000-00000000c001',
        changedFields: ['pt-domains'],
        occurredAt: CONTEXT.occurredAt,
        changeType: 'update',
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still delivers a change whose provenance does not parse, and says so', () => {
    const warn = jest.fn();
    const [event] = changeEventsOf(envelope({ context: { source: { type: 'nonsense' } } }), warn);
    expect(event?.externalId).toBe('00000000-0000-4000-8000-00000000c001');
    expect(event?.occurredAt).toBe('2026-10-19T10:00:01.000Z');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads nothing from a body that is not an envelope', () => {
    expect(changeEventsOf({ hello: 'world' }, jest.fn())).toEqual([]);
  });
});

describe('didWeAuthorChange', () => {
  const event = (context: unknown) => ({
    pipelineInputId: 'trigger:t-1',
    adapterType: 'kg',
    triggerType: 'mutation' as const,
    payload: { context },
  });

  it("is the automation's own write when a trigger or movement marker is present", () => {
    expect(didWeAuthorChange(event(CONTEXT))).toBe(true);
  });

  it('is not, for a person editing the record', () => {
    expect(didWeAuthorChange(event({ ...CONTEXT, source: { type: 'user_edit' } }))).toBe(false);
  });

  it('cannot tell without provenance', () => {
    expect(didWeAuthorChange(event(undefined))).toBeNull();
  });
});

describe('the declarations', () => {
  it('keeps the door its signed deliveries have always used', () => {
    expect(KG_INBOUND.providerKey.toUpperCase()).toBe('KG_MUTATION');
    expect(kgManifest({ changeWebhooks: true }).triggerKinds).toEqual(['KG_MUTATION']);
  });
});
