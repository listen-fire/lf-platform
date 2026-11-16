// The module manifests a 0.15 program is checked against: production's
// registry at 0.15.3 (`adapters/registry.ts` `ADAPTER_MANIFESTS` on main),
// each module at the version production ran. The platform's own modules and
// units are this package's copies of production's (`modules/`, `units/`);
// every other module is its published 0.15 package.

import type { AdapterManifest } from '@listen-fire/engine/public/adapter';

import { AFFINITY_MANIFEST } from '@listen-fire/affinity/manifest';
import { AIRTABLE_MANIFEST } from '@listen-fire/airtable/manifest';
import { ATTIO_MANIFEST } from '@listen-fire/attio/manifest';
import { DEALROOM_MANIFEST } from '@listen-fire/dealroom/manifest';
import { DROPBOX_MANIFEST } from '@listen-fire/dropbox/manifest';
import { EMAIL_MANIFEST } from '@listen-fire/email/manifest';
import { EVERTRACE_MANIFEST } from '@listen-fire/evertrace/manifest';
import { GMAIL_MANIFEST } from '@listen-fire/gmail/manifest';
import { GOOGLE_DRIVE_MANIFEST } from '@listen-fire/google-drive/manifest';
import { GOOGLE_SHEETS_MANIFEST } from '@listen-fire/google-sheets/manifest';
import { GRANOLA_MANIFEST } from '@listen-fire/granola/manifest';
import { MCP_MANIFEST } from '@listen-fire/mcp/manifest';
import { SLACK_MANIFEST } from '@listen-fire/slack/manifest';
import { TELEGRAM_MANIFEST } from '@listen-fire/telegram/manifest';
import { whatsappManifest } from '@listen-fire/whatsapp/manifest';

import { ASK_MANIFEST } from '../modules/ask/manifest';
import { kgManifest } from '../modules/kg/manifest';
import { NATIVE_VALUATIONS_MANIFEST } from '../modules/native-valuations/manifest';
import { SYSTEM_MANIFEST } from '../modules/system/manifest';
import { CRON_MANIFEST } from '../units/cron';
import { MANUAL_MANIFEST } from '../units/manual';

/** What of the deployment decides a manifest, as the platform reads it. */
export interface DeploymentFacts {
  /** The store's change events arrive as a signed POST (the kg's subscription
   *  methods are then real). */
  kgChangeWebhooks: boolean;
  /** The deployment lets a team connect MCP servers. */
  mcpEnabled: boolean;
  /** The shared WhatsApp number the manifest quotes, when one is set. */
  whatsappNumber: string | null;
}

/** The credential type an MCP connection is stored under on the platform. */
const MCP_CREDENTIAL_TYPE = 'MCP';

export function manifestsOf(deployment: DeploymentFacts): AdapterManifest[] {
  return [
    kgManifest({ changeWebhooks: deployment.kgChangeWebhooks }),
    ATTIO_MANIFEST,
    AFFINITY_MANIFEST,
    NATIVE_VALUATIONS_MANIFEST,
    SLACK_MANIFEST,
    TELEGRAM_MANIFEST,
    EMAIL_MANIFEST,
    whatsappManifest(deployment.whatsappNumber),
    AIRTABLE_MANIFEST,
    GOOGLE_SHEETS_MANIFEST,
    GOOGLE_DRIVE_MANIFEST,
    DROPBOX_MANIFEST,
    CRON_MANIFEST,
    MANUAL_MANIFEST,
    GRANOLA_MANIFEST,
    EVERTRACE_MANIFEST,
    DEALROOM_MANIFEST,
    GMAIL_MANIFEST,
    ASK_MANIFEST,
    SYSTEM_MANIFEST,
    ...(deployment.mcpEnabled ? [{ ...MCP_MANIFEST, requiredCredentialType: MCP_CREDENTIAL_TYPE }] : []),
  ];
}
