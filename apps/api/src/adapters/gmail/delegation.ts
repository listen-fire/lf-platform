// The platform's service account acting AS a Workspace mailbox (domain wide
// delegation), and the allowlist of mailboxes this installation may act as.
// Hosted only: lf and served modules reach a mailbox through a connected
// credential instead.

import { GoogleAuth } from 'google-auth-library';

import { googleServiceAccount } from 'model-providers/providers/google_account';

/**
 * The service account acting AS a mailbox, rather than as itself.
 *
 * The provider module's `googleAuth` authenticates the account for its own
 * cloud resources; this one impersonates a Workspace user, which is what
 * reading someone's inbox requires. The impersonation is granted once by a
 * Workspace admin against the account's client id, so nothing here can widen
 * it — an ungranted subject or scope fails at the token exchange with
 * `unauthorized_client`.
 */
export function delegatedGoogleAuth(input: {
  subject: string;
  scopes: readonly string[];
  env?: NodeJS.ProcessEnv;
}): GoogleAuth {
  const { privateKey, clientEmail } = googleServiceAccount(input.env ?? process.env);
  return new GoogleAuth({
    credentials: {
      type: 'service_account',
      private_key: privateKey,
      client_email: clientEmail,
    },
    scopes: [...input.scopes],
    clientOptions: { subject: input.subject },
  });
}

/**
 * The mailboxes THIS installation will act as. Google's domain wide delegation
 * has no per-mailbox limit of its own — once granted, the service account can
 * impersonate ANY address in the Workspace — so this list is the only thing
 * standing between "the delegation is granted" and "anyone can connect anyone
 * else's mailbox". Comma separated, compared case insensitively after
 * trimming.
 *
 * Unset (or empty) parses to an empty set, which every caller reads as "no
 * mailbox may be connected or used" — never as "every mailbox is allowed". An
 * unset list defaulting to "everything" would be a guarantee that silently is
 * not one.
 */
export function gmailMailboxAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.GMAIL_MAILBOX_ALLOWLIST ?? '';
  return new Set(
    raw
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter((address) => address !== ''),
  );
}
