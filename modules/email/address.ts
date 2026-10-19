// The address inbound mail has to be sent to, and how a routing key is read
// back out of it.
//
// It was `inbox+<key>@example.com`, spelled in three unrelated places: the
// door's recogniser regex, the trigger-config block the author edits, and the
// manifest prose the agent reads. Hardcoding one deployment's address broke
// every other deployment, so the whole address — local part AND domain — is
// one setting, read here and nowhere else.
//
// There is no default. A default would have every other deployment tell its
// authors to forward mail to somebody else's inbox (the same reasoning that
// took the hardcoded sending domain out of the Mailgun adapter). Unset is a
// gap the author is shown, not an address that quietly belongs to somebody
// else.

/** The setting that carries the whole address. */
const INBOUND_EMAIL_ADDRESS_VAR = 'INBOUND_EMAIL_ADDRESS';

interface RoutingAddress {
  /** `mail` in `inbox+<key>@example.com`. */
  localPart: string;
  /** `example.com` in `inbox+<key>@example.com`. */
  domain: string;
  /** What the author's key is prefixed with — `inbox+`. */
  prefix: string;
  /** What follows it — `@example.com`. */
  suffix: string;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse `mail@example.com` into its parts, or null when it is not an address. */
function parseRoutingAddress(value: string | undefined): RoutingAddress | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const localPart = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (localPart.includes('+')) return null;
  return { localPart, domain, prefix: `${localPart}+`, suffix: `@${domain}` };
}

/**
 * The deployment's routing address, or null when it has none configured.
 *
 * Read per call rather than captured at module load: the manifest is built
 * once at import, but the door and the dev-loop injector are both exercised by
 * tests that set the variable per case.
 */
function inboundRoutingAddress(env: NodeJS.ProcessEnv = process.env): RoutingAddress | null {
  return parseRoutingAddress(env[INBOUND_EMAIL_ADDRESS_VAR]);
}

/**
 * The routing key carried by one of these recipients, or null.
 *
 * `<local>+<key>@<domain>` is the address a listen is given. The
 * `<local>-<anything>+<key>@<domain>` variant is also accepted, because
 * provisioning has minted per-purpose local parts (`mail-dealflow+abc@…`) and
 * mail addressed to one of those still belongs to the same deployment.
 *
 * Matching is case-insensitive: a mail server may hand back the recipient in
 * whatever case the sender typed, and no deployment means two addresses that
 * differ only in case.
 */
function routingKeyFrom(
  recipients: string[],
  address: RoutingAddress | null = inboundRoutingAddress(),
): string | null {
  if (address === null) return null;
  const pattern = new RegExp(
    `^${escapeForRegex(address.localPart)}(?:-[\\S]+?)?\\+(\\S+)@${escapeForRegex(address.domain)}$`,
    'i',
  );
  for (const recipient of recipients) {
    const key = recipient.trim().match(pattern)?.[1];
    if (key !== undefined) return key;
  }
  return null;
}

export {
  INBOUND_EMAIL_ADDRESS_VAR,
  inboundRoutingAddress,
  parseRoutingAddress,
  routingKeyFrom,
  type RoutingAddress,
};
