// Which way a drained mutation event leaves knowledge. Read at the composition
// root, and again by the drainer for every row it delivers.
//
// A deployment has EXACTLY ONE active path: composed has the automations drain
// take each event straight off the outbox into its inbound path (no HTTP hop);
// standalone runs the registered webhooks, because automations is a different
// process. Delivering both for the
// same row is a double-fire — the listener runs twice off one graph write — so
// the choice is a mode, not a pair of independently-enabled features.
//
// Composed is the shipped deployment, so an absent variable means `local`. An
// unrecognised one is a boot failure rather than a quiet fall back to it: the
// two modes are different delivery guarantees, and a typo must not pick one.

type MutationDelivery = 'local' | 'webhook';

type Env = Record<string, string | undefined>;

function mutationDelivery(env: Env = process.env): MutationDelivery {
  const raw = env.KNOWLEDGE_MUTATION_DELIVERY;
  if (raw === undefined || raw === '' || raw === 'local') return 'local';
  if (raw === 'webhook') return 'webhook';
  throw new Error(`KNOWLEDGE_MUTATION_DELIVERY must be "local" or "webhook" (got "${raw}").`);
}

export { type MutationDelivery, mutationDelivery };
