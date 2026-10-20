// Wiring pin for the shared-number WhatsApp door. The door answers Meta only
// once every message of the delivery is a `whatsapp_message` row, keyed on its
// wamid, and does nothing else in the request; the dispatch, a tapped
// callback's fire and reply, and the ops notice run when the row drains. A
// tapped interactive reply button must be recognised and acked by the callback
// door, and — unlike Telegram's single callback_query per delivery — the
// rest of the SAME batch must still reach `dispatchWhatsappMessage`
// unaffected (a delivery can carry a tap alongside a plain message). The
// callback door's own recognition/ack/mismatch rules are pinned in
// `services/webhook_sync/__test__/whatsapp_callback_door.unit.test.ts`; this
// file only pins that `interfaces/whatsapp/webhook.ts` actually calls it, with
// the real door logic (only the router and the Meta send client are mocked).

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/slack', () => ({ sendSlackNotification: jest.fn(async () => {}) }));
jest.mock('../../../services/whatsapp/utils', () => ({
  resolveWhatsappSender: jest.fn(async () => ({ teamId: 'team-1', displayName: 'Ada' })),
}));
jest.mock('movement-engine/public/inbound', () => ({
  ...jest.requireActual('movement-engine/public/inbound'),
  verifyWithScheme: jest.fn(() => true),
}));

const dispatchWhatsappMessage = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('../../../services/whatsapp/dispatch', () => ({
  dispatchWhatsappMessage: (...args: unknown[]) => dispatchWhatsappMessage(...args),
}));

const sendTextMessageMock = jest.fn(async () => 'wamid.ACK');
jest.mock('../../../services/whatsapp/metaApi', () => ({
  getMetaWhatsappApi: jest.fn(() => ({ sendTextMessage: sendTextMessageMock })),
}));

// The router is mocked; recognition (`ownsWhatsappInteractiveReply`) and the
// ack wiring (`handleWhatsappInteractiveReplies`) are the REAL implementation
// under test.
const fireCallback = jest.fn();
jest.mock('../../../services/movement_engine/callback_fire', () => ({
  ...jest.requireActual('../../../services/movement_engine/callback_fire'),
  fireCallback: (input: unknown) => fireCallback(input),
}));

/** The rows the door queued, in order: what the drain would run. */
let queued: { kind: string; key: string; payload: unknown }[] = [];
let holdEnqueue: Promise<void> | undefined;
jest.mock('../../../services/work/store', () => ({
  enqueueWork: async (row: { kind: string; key: string; payload: unknown }) => {
    await holdEnqueue;
    queued.push(row);
  },
}));
jest.mock('../../../services/work/drain', () => ({
  ...jest.requireActual('../../../services/work/drain'),
  notifyWork: () => {},
}));

import { receiveWebhook } from '../webhook';
import { whatsappMessageHandler } from '../../../services/whatsapp/inbound_message';

function fakeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

// A configured app secret and a signature header, because the door is now
// fail-closed without one (`lib/unsigned_webhooks`). The signature check is
// mocked true above — the HMAC is Meta's business, not this wiring pin's.
function deliver(body: unknown) {
  const req = { get: () => 'sha256=stub', body } as any;
  const res = fakeRes();
  const handler = receiveWebhook({ verifyToken: undefined, appSecret: 'test-app-secret' });
  return { req, res, promise: handler(req, res as any) };
}

function metaBody(message: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID_1' },
              contacts: [{ wa_id: '+15551234567', profile: { name: 'Dev Sender' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendTextMessageMock.mockResolvedValue('wamid.ACK');
  queued = [];
  holdEnqueue = undefined;
});

const ctx = (attempts: number) => ({ now: new Date(), owner: 'test', attempts, heartbeat: async () => {} });

/** Run the rows the door queued, as the drain would. */
async function flush() {
  for (const row of queued) {
    expect(row.kind).toBe('whatsapp_message');
    await whatsappMessageHandler.run(row.payload, ctx(1));
  }
}

describe('durable, then answered: the drain does the work', () => {
  const text = (id: string) => ({ from: '15551234567', id, timestamp: '1700000000', type: 'text', text: { body: 'hi' } });
  const { sendSlackNotification } = jest.requireMock('../../../lib/slack') as { sendSlackNotification: jest.Mock };

  it('answers only after the row is written, and does nothing in the request', async () => {
    let release: () => void = () => {};
    holdEnqueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { res, promise } = deliver(metaBody(text('wamid.HELD')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(res.status).not.toHaveBeenCalled();
    expect(res.sendStatus).not.toHaveBeenCalled();

    release();
    await promise;
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('EVENT_RECEIVED');
    expect(queued.map((row) => [row.kind, row.key])).toEqual([['whatsapp_message', 'whatsapp_message:wamid.HELD']]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatchWhatsappMessage).not.toHaveBeenCalled();
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('runs the dispatch and the ops notice when the row drains', async () => {
    await deliver(metaBody(text('wamid.D1'))).promise;
    await flush();

    expect(dispatchWhatsappMessage).toHaveBeenCalledWith({
      message: text('wamid.D1'),
      profileName: 'Dev Sender',
      businessNumber: '15550000000',
      businessPhoneNumberId: 'PNID_1',
    });
    expect(sendSlackNotification).toHaveBeenCalledTimes(1);
  });

  it("keys Meta's resend onto the same row as the first delivery", async () => {
    await deliver(metaBody(text('wamid.R1'))).promise;
    await deliver(metaBody(text('wamid.R1'))).promise;

    expect(queued.map((row) => row.key)).toEqual(['whatsapp_message:wamid.R1', 'whatsapp_message:wamid.R1']);
  });

  it('answers 500 when a row cannot be written, so Meta resends', async () => {
    holdEnqueue = Promise.reject(new Error('work table unreachable'));
    holdEnqueue.catch(() => {});

    const { res, promise } = deliver(metaBody(text('wamid.F1')));
    await promise;

    expect(res.sendStatus).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(200);
  });

  it('acks a delivery with no messages and writes nothing', async () => {
    const { res, promise } = deliver({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.1' }] } }] }] });
    await promise;

    expect(res.status).toHaveBeenCalledWith(200);
    expect(queued).toHaveLength(0);
  });

  it('a failed dispatch fails the row so it retries, before the ops notice, and is given up on after many attempts', async () => {
    dispatchWhatsappMessage.mockRejectedValue(new Error('trigger table unreachable'));
    await deliver(metaBody(text('wamid.X1'))).promise;
    const payload = queued[0]?.payload;

    await expect(whatsappMessageHandler.run(payload, ctx(1))).rejects.toThrow(/unreachable/);
    expect(sendSlackNotification).not.toHaveBeenCalled();
    await expect(whatsappMessageHandler.run(payload, ctx(10))).resolves.toBeUndefined();
    dispatchWhatsappMessage.mockReset();
    dispatchWhatsappMessage.mockResolvedValue(undefined);
  });
});

describe('the shared WhatsApp door: a callback-id tap', () => {
  it('is fired and acked with a threaded reply — and never reaches dumb dispatch for THIS message', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: { singleUse: true } });
    const message = {
      from: '15551234567',
      id: 'wamid.TAP',
      timestamp: '1700000000',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'cb_abc', title: 'Ship' } },
    };
    const { res, promise } = deliver(metaBody(message));
    await promise;
    await flush();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_abc', values: {} });
    expect(sendTextMessageMock).toHaveBeenCalledWith(
      '15551234567',
      'Thanks — that has been recorded.',
      { replyToMessageId: 'wamid.TAP' },
    );
    // The number that received the tap sends the ack — the responder is keyed
    // by `phone_number_id`, exactly like every other WhatsApp send.
    const getMetaWhatsappApi = jest.requireMock('../../../services/whatsapp/metaApi')
      .getMetaWhatsappApi as jest.Mock;
    expect(getMetaWhatsappApi).toHaveBeenCalledWith('PNID_1');
  });

  it("acks with the closed wording when the callback is already settled — and the ack goes out regardless", async () => {
    fireCallback.mockResolvedValue({ kind: 'closed', callback: {} });
    const message = {
      from: '15551234567',
      id: 'wamid.TAP2',
      timestamp: '1700000001',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'cb_gone', title: 'Ship' } },
    };
    await deliver(metaBody(message)).promise;
    await flush();

    expect(sendTextMessageMock).toHaveBeenCalledWith(
      '15551234567',
      'This request was already closed.',
      { replyToMessageId: 'wamid.TAP2' },
    );
  });
});

describe('a batch that mixes a tap with an ordinary message', () => {
  it('handles the tap AND still dispatches the ordinary message untouched', async () => {
    fireCallback.mockResolvedValue({ kind: 'recorded', callback: { singleUse: true } });
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID_1' },
                contacts: [{ wa_id: '+15551234567', profile: { name: 'Dev Sender' } }],
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.TAP3',
                    timestamp: '1700000002',
                    type: 'interactive',
                    interactive: { type: 'button_reply', button_reply: { id: 'cb_xyz', title: 'Ship' } },
                  },
                  {
                    from: '15551234567',
                    id: 'wamid.PLAIN',
                    timestamp: '1700000003',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await deliver(body).promise;
    await flush();

    expect(fireCallback).toHaveBeenCalledTimes(1);
    expect(fireCallback).toHaveBeenCalledWith({ id: 'cb_xyz', values: {} });
    // Dumb dispatch still runs over EVERY message in the batch — the door
    // narrows what fires a callback, never what reaches ordinary handling.
    expect(dispatchWhatsappMessage).toHaveBeenCalledTimes(2);
  });
});

describe('a non-callback button flows on untouched', () => {
  it("someone's own button vocabulary is never fired through the router", async () => {
    const message = {
      from: '15551234567',
      id: 'wamid.OWN',
      timestamp: '1700000004',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'menu_refresh', title: 'Refresh' } },
    };
    await deliver(metaBody(message)).promise;
    await flush();

    expect(fireCallback).not.toHaveBeenCalled();
    expect(sendTextMessageMock).not.toHaveBeenCalled();
    expect(dispatchWhatsappMessage).toHaveBeenCalledTimes(1);
  });
});

// A rejected signature used to log NOTHING beyond the 401 — an operator whose
// deliveries all bounce (a second Meta app subscribed to the same WhatsApp
// Business Account, signing with a different app secret; or a rotated
// secret) saw only 401s in the access log with no reason. These pin that the
// mismatch and missing-header branches now explain themselves.
describe('a signature that does not verify', () => {
  function deliverWithSignature(body: unknown, signatureHeader: string | undefined) {
    const req = { get: () => signatureHeader, body } as any;
    const res = fakeRes();
    const handler = receiveWebhook({ verifyToken: undefined, appSecret: 'test-app-secret' });
    return { req, res, promise: handler(req, res as any) };
  }

  const { verifyWithScheme } = jest.requireMock('movement-engine/public/inbound') as { verifyWithScheme: jest.Mock };
  const { logger } = jest.requireMock('movement-engine/services/logger') as {
    logger: { warn: jest.Mock };
  };

  it('logs a warn naming the second-app/rotated-secret cause and 401s on a mismatch', async () => {
    verifyWithScheme.mockReturnValueOnce(false);
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-123',
          changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID_1' } } }],
        },
      ],
    };

    const { res, promise } = deliverWithSignature(body, 'sha256=wrong');
    await promise;

    expect(res.sendStatus).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[whatsapp/webhook] REJECTING inbound: signature did not verify against WHATSAPP_WEBHOOK_SECRET — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)",
      { hasSignature: true, businessAccountId: 'waba-123', phoneNumberId: 'PNID_1' },
    );
  });

  it('logs a warn naming the absent header and 401s when no signature header arrives', async () => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'waba-456', changes: [] }] };

    const { res, promise } = deliverWithSignature(body, undefined);
    await promise;

    expect(res.sendStatus).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[whatsapp/webhook] REJECTING inbound: X-Hub-Signature-256 header was absent — the sending Meta app's secret differs (a second app subscribed to this WhatsApp Business Account, or the secret was reset in Meta)",
      { hasSignature: false, businessAccountId: 'waba-456', phoneNumberId: null },
    );
    // verifySignature is never reached without a header — nothing to verify.
    expect(verifyWithScheme).not.toHaveBeenCalled();
  });

  it('never warns on a valid signature — 200 and dispatch proceeds', async () => {
    const message = {
      from: '15551234567',
      id: 'wamid.OK',
      timestamp: '1700000005',
      type: 'text',
      text: { body: 'hi' },
    };
    const { res, promise } = deliverWithSignature(metaBody(message), 'sha256=valid');
    await promise;
    await flush();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(dispatchWhatsappMessage).toHaveBeenCalledTimes(1);
  });
});
