// The `connect-credential` connect-action handler.
//
// Runs the real OAuth flow for an integration's credential — the same flow
// the Connections page's IntegrationModal uses — but triggered from the chat
// affordance. The agent's offerCredentialConnect tool emits a suggestedAction
// with connectAction { kind: 'connect-credential', adapter, serviceType };
// panel.tsx dispatches it here. On success the credential is persisted and the
// catalog refreshed, and the panel sends a follow-up so the agent resumes.
//
// OAuth chain (mirrors integration-modal.tsx):
//   <service>ConnectUrl.mutate() -> window.open(popup)
//   -> BroadcastChannel('listen-fire-oauth') yields { claimToken }
//   -> addCredential.mutate({ name, type, claimToken, use }) claims + stores it,
//      with who may use it, asked of the person before the popup opens.

import { ExternalServiceType } from "#trpc";
import {
  registerConnectActionHandler,
  type ConnectActionContext,
  type ConnectActionTrpcClient,
} from './registry';

/** Per-service connect-url mutation, keyed by ExternalServiceType string —
 *  mirrors integration-modal.tsx's urlGetters. Returns undefined for a
 *  service with no OAuth connect flow. */
export function selectConnectUrlMutation(
  serviceType: string,
  client: ConnectActionTrpcClient,
): (() => Promise<string | undefined>) | undefined {
  const pc = client.views?.credentials;
  if (!pc) return undefined;
  const map: Record<string, () => Promise<string | undefined>> = {
    SLACK: () => pc.slackConnectUrl.mutate(),
    AIRTABLE: () => pc.airtableConnectUrl.mutate(),
    ATTIO: () => pc.attioConnectUrl.mutate(),
    GOOGLE: () => pc.googleConnectUrl.mutate(),
    // Answers only on a deployment that connects Gmail by sign-in; elsewhere it
    // resolves undefined, which the handler reports as "no OAuth flow here".
    GOOGLE_GMAIL: () => pc.gmailConnectUrl.mutate(),
    DROPBOX: () => pc.dropboxConnectUrl.mutate(),
  };
  return map[serviceType];
}

/** Open the OAuth popup and resolve with the claimToken from the
 *  'listen-fire-oauth' broadcast — or null if the user abandons the popup or it
 *  times out, so a dispatched chat turn never hangs waiting for a grant
 *  that will not arrive. */
function awaitOAuthClaim(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const ch = new BroadcastChannel('listen-fire-oauth');
    let settled = false;
    let pollId: ReturnType<typeof setInterval> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      ch.close();
      if (pollId !== undefined) clearInterval(pollId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve(value);
    };

    ch.onmessage = (event) => {
      const claimToken = (event.data as { claimToken?: string })?.claimToken;
      if (claimToken) settle(claimToken);
    };

    const popup = window.open(url, '_blank');
    // No claim is broadcast if the user closes the popup without finishing —
    // poll for its closure so this resolves null rather than hanging.
    if (popup) {
      pollId = setInterval(() => {
        if (popup.closed) settle(null);
      }, 500);
    }
    // Backstop so an abandoned flow never stalls the turn indefinitely.
    timeoutId = setTimeout(() => settle(null), 5 * 60_000);
  });
}

async function connectCredentialHandler(ctx: ConnectActionContext): Promise<void> {
  if (!ctx.serviceType) {
    throw new Error('connect-credential needs a serviceType.');
  }
  const getUrl = selectConnectUrlMutation(ctx.serviceType, ctx.client);
  if (!getUrl) {
    throw new Error(`No OAuth connect flow for ${ctx.serviceType}.`);
  }
  // Asked before anything opens: declining creates nothing.
  const use = await ctx.chooseUse();
  if (use === null) return;

  const url = await getUrl();
  // No install URL means this deployment registered no OAuth app for the
  // service, so there is nothing to open. Fail the way an unknown service type
  // does rather than resolving — a silent resolve makes the panel announce a
  // connection that never happened.
  if (!url) {
    throw new Error(`No OAuth connect flow for ${ctx.serviceType} on this server.`);
  }

  const claimToken = await awaitOAuthClaim(url);
  if (!claimToken) return; // popup closed without completing

  await ctx.client.views.credentials.addCredential.mutate({
    name: ctx.adapter,
    type: ctx.serviceType as ExternalServiceType,
    claimToken,
    use,
  });

  ctx.refreshInstance({
    adapter: ctx.adapter,
    ...(ctx.credential !== undefined ? { credential: ctx.credential } : {}),
  });
}

registerConnectActionHandler('connect-credential', connectCredentialHandler);
