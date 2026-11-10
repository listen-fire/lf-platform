// The app-shipped handler registry for adapter "connect actions".
//
// An adapter declares interactive connect actions in its manifest
// (`connectActions: [{ kind, label }]`); that DECLARATION travels through the
// catalog to wherever an author composes a movement — the editor's suggestion
// list and the chat affordance alike. The HANDLER that actually runs the
// action is app-shipped and lives here, keyed by `kind`. The framework never
// hardcodes a specific adapter or UI: it routes a `kind` to this map.
//
// This is the minimal-coupling line the plan draws: the declaration is general
// (any adapter, local or remote, may declare a connect action), but a remote
// adapter may only reference a `kind` the app already ships a handler for.

import { trpc } from "@/lib/trpc";
import type { Grantee } from "@/components/access/grantees";

/** The tRPC vanilla client (`trpc.useUtils().client`) — what handlers call
 *  the server through, without React Query hooks. */
export type ConnectActionTrpcClient = ReturnType<typeof trpc.useUtils>["client"];

/** What a connect-action handler is given when invoked. The adapter instance
 *  in play (so the handler persists the grant against the right credential),
 *  the tRPC client (handlers talk to the server through it), and a callback
 *  to refresh the catalog once the grant lands (so newly-granted entries
 *  appear in suggestions without a reload). */
export interface ConnectActionContext {
  /** The adapter slug the instance constructs. */
  adapter: string;
  /** The construction's credential import name, when it has one. */
  credential?: string;
  /** tRPC vanilla client for server calls. */
  client: ConnectActionTrpcClient;
  /** Re-introspect the (adapter, credential) instance so a freshly-granted
   *  entry shows up in completions. */
  refreshInstance: (pair: { adapter: string; credential?: string }) => void;
  /** The ExternalServiceType string for a credential connect, when the action
   *  is a credential OAuth flow. */
  serviceType?: string;
  /** Ask the person who may use a connection the action is about to create;
   *  null when they decline, and nothing is created. */
  chooseUse: () => Promise<Grantee[] | null>;
}

export type ConnectActionHandler = (ctx: ConnectActionContext) => Promise<void>;

const HANDLERS: Record<string, ConnectActionHandler> = {};

/** Register an app-shipped handler for a connect-action `kind`. Idempotent —
 *  re-registering the same kind overwrites (handlers are pure modules). */
export function registerConnectActionHandler(
  kind: string,
  handler: ConnectActionHandler,
): void {
  HANDLERS[kind] = handler;
}

/** Run the handler for `kind`, if one is shipped. Returns false when no
 *  handler is registered (an adapter referenced a kind the app doesn't know —
 *  the editor leaves the entry inert rather than crashing). */
export async function runConnectAction(
  kind: string,
  ctx: ConnectActionContext,
): Promise<boolean> {
  const handler = HANDLERS[kind];
  if (!handler) return false;
  await handler(ctx);
  return true;
}

/** Whether the app ships a handler for this kind. */
export function hasConnectActionHandler(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}
