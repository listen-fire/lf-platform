// The platform's store under the push doors a REMOTE adapter calls when it
// owns its own inbound URL (the doors themselves are the shared inbound core's
// `answerWake`; `answerEmit` refuses by name, since from 0.13 an event fires
// no listen): what arrived on the install's listenable edges is kept as a
// delivery of its own, judged by the team's listens on that module and
// waking the waits parked on each record (inbound/listen_door.ts), and judged
// by each carried version's listens on the module with that version's own
// judge (inbound/carried_delivery.ts).
//
// The caller presents the credential its install holds (the same secret
// Listen-Fire authenticates to it with, carried the same way the install's
// `authStrategy` says), and the install whose secret matches is the team. Only a
// credential shared by several teams' installs needs the team named as well.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { InboundHeaders, PushAuth, PushCaller, PushStore } from 'movement-engine/public/inbound';

import { teamIdSchema } from '../../lib/team_id';
import { loadRemoteAdapterSecret } from '../translation_graph/adapters/resolve';
import { RemoteAdapterManifestFile } from '../translation_graph/adapters/remote/manifest';
import { mayBeRemoteSlug } from '../translation_graph/adapters/remote/slugs';
import { listRemoteAdaptersOfType, type RemoteAdapterRow } from '../translation_graph/adapters/remote/store';
import { ADAPTER_TEAM_HEADER, authHeader } from 'movement-engine/public/adapter';
import { deliverArrivals } from '../inbound/listen_door';
import { keptPage } from '../inbound/captured_request';
import { judgeCarriedPage } from '../inbound/carried_delivery';
import { notifyWork } from '../work/drain';
import { logger } from 'movement-engine/public/log';
import { webhookProviderKey } from './urls';

/** The credential matches no install of the type (or there is none, or the
 *  named team has none, or the slug is one a built-in answers to) — one answer
 *  for all four (`unauthorized`), so an anonymous caller cannot probe who
 *  installed what. */
export type AdapterDoorAuth = PushAuth;

const AuthStrategySchema = RemoteAdapterManifestFile.shape.authStrategy;

/** Digests first, so the comparison is constant-time whatever the lengths. */
function sameSecret(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function headerValue(headers: InboundHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return typeof value === 'string' ? value : value?.[0];
}

/** Whether the presented headers carry this install's secret, the way its
 *  strategy sends it (the header the install sends to the remote is the one
 *  the remote sends back). An unreadable install never matches. */
async function presentsSecretOf(install: RemoteAdapterRow, headers: InboundHeaders): Promise<boolean> {
  if (install.credentials_id === null) return false;
  const strategy = AuthStrategySchema.safeParse(install.auth_strategy);
  if (!strategy.success) return false;
  let secret: string;
  try {
    secret = await loadRemoteAdapterSecret(install.credentials_id, teamIdSchema.parse(install.team_id), install.adapter_type);
  } catch (err) {
    logger.warn('[AdapterDoors] install secret unreadable; skipped', {
      adapterType: install.adapter_type,
      teamId: install.team_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  let matched = false;
  for (const [name, expected] of Object.entries(authHeader(strategy.data, secret))) {
    const presented = headerValue(headers, name);
    if (presented !== undefined && sameSecret(presented, expected)) matched = true;
  }
  return matched;
}

/**
 * Find the install the presented credential belongs to. Every candidate is
 * checked — no early exit — so the answer's timing does not say which install
 * matched. A caller whose credential is shared across teams names its team in
 * `x-listen-fire-team`, which narrows the candidates to that team's install.
 */
export async function authenticateAdapterDoor(input: {
  adapterType: string;
  headers: InboundHeaders;
}): Promise<AdapterDoorAuth> {
  // A slug a built-in answers to is never a remote install's, whatever row
  // the table holds — the same answer as no install, so it says nothing.
  if (!mayBeRemoteSlug(input.adapterType)) return { kind: 'unauthorized' };
  const namedTeam = headerValue(input.headers, ADAPTER_TEAM_HEADER);
  let teamId: TeamId | undefined;
  if (namedTeam !== undefined) {
    const parsed = teamIdSchema.safeParse(namedTeam);
    if (!parsed.success) return { kind: 'unauthorized' };
    teamId = parsed.data;
  }
  const installs = await listRemoteAdaptersOfType({
    adapterType: input.adapterType,
    ...(teamId !== undefined ? { teamId } : {}),
  });

  const matches: PushCaller[] = [];
  for (const install of installs) {
    if (install.credentials_id !== null && (await presentsSecretOf(install, input.headers))) {
      matches.push({
        teamId: teamIdSchema.parse(install.team_id),
        adapterType: install.adapter_type,
        credentialsId: install.credentials_id,
      });
    }
  }
  const [caller, ...others] = matches;
  if (caller === undefined) return { kind: 'unauthorized' };
  if (others.length > 0) return { kind: 'ambiguous' };
  return { kind: 'authenticated', caller };
}

/** The platform's store under the push doors: installs and their secrets,
 *  and a push's arrivals kept as a delivery of the install, which serves
 *  every connection of its module. */
export const platformPushStore: PushStore = {
  authenticate: (input) => authenticateAdapterDoor(input),

  async keepArrivals({ adapterType, teamId, arrivals }) {
    const team = teamIdSchema.parse(teamId);
    const { deliveryId } = await deliverArrivals({
      teamId: team,
      delivered: { adapterType, credentialsId: null },
      subscriptionId: webhookProviderKey({ adapterType }),
      externalId: null,
      source: 'emit',
      arrivals,
      // The module pushed arrivals, not a provider's request: a replay judges
      // them again as pushed.
      request: keptPage({ adapterType, credentialsId: null, arrivals }),
    });
    // A carried version's listens on the module judge the pushed arrivals with
    // their own judge; the push names no id, so its kept delivery names it.
    await judgeCarriedPage({ teamId: team, adapterType, credentialsId: null, page: arrivals, stableKey: `push:${deliveryId}` });
  },

  notify: () => notifyWork(),
};
