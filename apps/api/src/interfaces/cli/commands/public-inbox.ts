import { Command, command, metadata, option, Options } from 'clime';
import { neverAsAny } from 'movement-engine/public/types';

import { globalQb } from '../../../lib/kysely';
import { principalDirectory } from '../../../services/principal';
import {
  claimPublicInbox,
  listPublicInboxes,
  releasePublicInbox,
  type PublicInbox,
} from '../../../services/translation_graph/adapters/email/public_inbox';

class PublicInboxOptions extends Options {
  @option({ description: 'Team id', required: true })
  team!: string;

  @option({ description: 'Open this inbound key to mail from anyone, for the team (needs --by)' })
  claim?: string;

  @option({ description: 'Close this key again; only the team holding it can' })
  release?: string;

  @option({ description: 'Email of the team member a run acts as when the sender is not on the team' })
  by?: string;
}

function describe(inbox: PublicInbox): string {
  return `  ${inbox.key}${inbox.address !== null ? ` (${inbox.address})` : ''} — runs act as ${inbox.claimedByUserId} for senders outside the team`;
}

/**
 * Public inboxes for an installation without the web app: the same claim, and
 * the same refusal of a key another team holds, as the API and MCP surfaces.
 * The operator names who a run acts as (`--by`), since the CLI is nobody on
 * the team itself.
 */
@command({ description: "List, claim or release a team's public inboxes (inbound keys that take mail from anyone)" })
export default class extends Command {
  @metadata
  async execute(options: PublicInboxOptions): Promise<void> {
    try {
      await this.run(options);
    } finally {
      await globalQb.destroy();
    }
  }

  private async run(options: PublicInboxOptions): Promise<void> {
    if (options.claim !== undefined && options.release !== undefined) {
      throw new Error('--claim and --release are separate changes: pass one.');
    }

    if (options.claim !== undefined) {
      if (options.by === undefined) {
        throw new Error('--claim needs --by <email>: the team member a run acts as when the sender is not on the team.');
      }
      const claimant = await principalDirectory().userByEmail({ email: options.by, teamId: options.team });
      if (claimant?.hasAccess !== true) {
        throw new Error(`${options.by} is not a member of team ${options.team} who may act for it.`);
      }
      const result = await claimPublicInbox({ teamId: options.team, key: options.claim, claimedByUserId: claimant.id });
      switch (result.status) {
        case 'claimed':
          console.warn(`team ${options.team}: claimed public inbox`);
          console.warn(describe(result.inbox));
          return;
        case 'already_claimed':
          console.warn(`team ${options.team}: already holds this public inbox`);
          console.warn(describe(result.inbox));
          return;
        case 'held_by_another_team':
          throw new Error(`"${result.key}" is already a public inbox of team ${result.teamId}; it can only be claimed once that team releases it.`);
        case 'invalid_key':
          throw new Error(`"${options.claim}" cannot be a public inbox key: ${result.reason}.`);
        default:
          return neverAsAny(result);
      }
    }

    if (options.release !== undefined) {
      const result = await releasePublicInbox({ teamId: options.team, key: options.release });
      switch (result.status) {
        case 'released':
          console.warn(`team ${options.team}: released public inbox "${result.key}"; mail to it is routed by its sender again`);
          return;
        case 'not_claimed':
          console.warn(`"${result.key}" is not a public inbox of any team; nothing to release`);
          return;
        case 'held_by_another_team':
          throw new Error(`"${result.key}" is a public inbox of team ${result.teamId}, not of team ${options.team}; only that team can release it.`);
        default:
          return neverAsAny(result);
      }
    }

    const inboxes = await listPublicInboxes(options.team);
    console.warn(`team ${options.team}: ${inboxes.length === 0 ? 'no public inboxes' : `${inboxes.length} public inbox(es)`}`);
    for (const inbox of inboxes) console.warn(describe(inbox));
  }
}
