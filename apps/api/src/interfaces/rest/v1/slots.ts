// A core slot served at a platform route: adapter protocol 2's envelope over
// Express. The envelope's rules are the language's own
// (`answerSlotRequest`, the function `serveSlot` answers through), so a client
// that reaches a module process reaches this route the same way. Who may call
// it is the router's question (the system caller and its key); this is only
// the HTTP side: reading the body the middleware parsed and writing the
// answer's status and JSON.

import type { Request, RequestHandler } from 'express';
import type { WireSlotManifestShape } from 'engine-contracts/slots';
import { SlotRefusal, answerSlotRequest, type SlotAnswer } from 'movement-engine/public/module-wire';

import { logger } from 'movement-engine/public/log';

/** Serve `manifest`'s slot, answering each request with what `answerFor`
 *  makes of it (the tenant a request acts in is read off the request). */
export function slotHandler(manifest: WireSlotManifestShape, answerFor: (req: Request) => SlotAnswer): RequestHandler {
  return async (req, res) => {
    const answered = await answerSlotRequest(
      manifest,
      async (method, params, settings) => {
        try {
          return await answerFor(req)(method, params, settings);
        } catch (error) {
          // A store failure is the server's to see; a refusal is the caller's.
          // Never the params or settings: they may carry a callback's state.
          if (!(error instanceof SlotRefusal)) {
            logger.warn(`[slots:${manifest.slot}] ${method} failed`, { error: error instanceof Error ? error.message : String(error) });
          }
          throw error;
        }
      },
      req.body,
    );
    res.status(answered.status).json(answered.body);
  };
}
