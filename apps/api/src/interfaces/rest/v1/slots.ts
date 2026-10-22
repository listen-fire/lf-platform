// A core slot served at a platform route: adapter protocol 2's envelope over
// Express, with the rules of the language's own slot server
// (module-runtime `module_wire/wire.ts` `serveSlot`), so a client that reaches a
// module process reaches this route the same way. Who may call it is the
// router's question (the system caller and its key); this is only the wire:
//
//   • a body that is not the envelope is 400 `bad_request`, unless it names
//     another protocol version, which is answered (200) `protocol_version`;
//   • `manifest` is answered with the slot's manifest;
//   • every other method is the slot's answer, as a 200 envelope: `ok: true`
//     with its result (`null` for none), or `ok: false` with the refusal's
//     code (not retryable), or `module_error` for anything else (retryable).

import type { Request, RequestHandler } from 'express';
import { PROTOCOL_VERSION } from 'engine-contracts';
import { SlotRequestEnvelope, type WireSlotManifestShape } from 'engine-contracts/slots';
import { SlotRefusal, type SlotAnswer } from 'module-runtime/module_wire/wire';

import { logger } from 'movement-engine/public/log';

/** Serve `manifest`'s slot, answering each request with what `answerFor`
 *  makes of it (the tenant a request acts in is read off the request). */
export function slotHandler(manifest: WireSlotManifestShape, answerFor: (req: Request) => SlotAnswer): RequestHandler {
  return async (req, res) => {
    const body: unknown = req.body;
    const envelope = SlotRequestEnvelope.safeParse(body);
    if (!envelope.success) {
      const version = body !== null && typeof body === 'object' ? Reflect.get(body, 'protocolVersion') : undefined;
      if (version !== undefined && version !== PROTOCOL_VERSION) {
        res.status(200).json({ ok: false, error: { code: 'protocol_version', message: `this module speaks protocol ${PROTOCOL_VERSION}`, retryable: false } });
        return;
      }
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const { method, params, settings } = envelope.data;
    try {
      const result = method === 'manifest' ? manifest : await answerFor(req)(method, params, settings ?? {});
      res.status(200).json({ ok: true, result: result ?? null });
    } catch (error) {
      const refusal = error instanceof SlotRefusal ? error : undefined;
      const message = error instanceof Error ? error.message : String(error);
      // A store failure is the server's to see; a refusal is the caller's.
      // Never the params or settings: they may carry a callback's state.
      if (refusal === undefined) logger.warn(`[slots:${manifest.slot}] ${method} failed`, { error: message });
      res.status(200).json({
        ok: false,
        error: {
          code: refusal?.code ?? 'module_error',
          message,
          retryable: refusal === undefined,
          ...(refusal?.data !== undefined ? { data: refusal.data } : {}),
        },
      });
    }
  };
}
