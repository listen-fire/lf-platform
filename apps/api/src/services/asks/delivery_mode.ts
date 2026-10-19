// How a settled ask tells whoever was waiting. Read at the composition root,
// and again at every settle.
//
// A deployment has EXACTLY ONE active path, for the same reason knowledge's
// mutation events do (D39c): composed, the answering request nudges the
// movement engine in-process, because the engine is right here; standalone,
// there is no engine and the waiter is whoever supplied a `callback_url`, so
// the settle is queued and delivered as a signed POST. Doing both would
// announce one answer twice.
//
// Composed is the shipped deployment, so an absent variable means `local`. An
// unrecognised one is a boot failure rather than a quiet fall back to it: the
// two are different notification contracts, and a typo must not pick one.

type AskSettleDelivery = 'local' | 'webhook';

type Env = Record<string, string | undefined>;

function askSettleDelivery(env: Env = process.env): AskSettleDelivery {
  const raw = env.ASKS_SETTLE_DELIVERY;
  if (raw === undefined || raw === '' || raw === 'local') return 'local';
  if (raw === 'webhook') return 'webhook';
  throw new Error(`ASKS_SETTLE_DELIVERY must be "local" or "webhook" (got "${raw}").`);
}

export { type AskSettleDelivery, askSettleDelivery };
