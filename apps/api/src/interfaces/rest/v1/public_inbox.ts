// Public inboxes on the Automation connector (`/api/v1/automation/inboxes`):
// list a team's, claim a key so it takes mail from anyone, release one again.
// The decision itself (one team per key, refused when it is claimed) is the
// service's (`adapters/email/public_inbox.ts`); this is its REST face, which
// the MCP tools and any API client share.
//
// Claiming and releasing take write access on the team, the role that manages
// its members, because a public inbox lets anyone who learns the address start
// the team's automations. The person claiming is who a run acts as when the
// sender is not on the team, so a machine credential (no person) cannot claim.
// A clash names the key, not the other team: which team holds it is that
// team's business, and the operator CLI says it.

import { randomUUID } from 'node:crypto';

import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { currentPrincipal } from 'principal';
import { neverAsAny } from 'movement-engine/public/types';

import {
  claimPublicInbox,
  listPublicInboxes,
  releasePublicInbox,
  type PublicInbox,
} from '../../../services/translation_graph/adapters/email/public_inbox';
import { listAccessibleTeams, resolveToolTeam, ToolTeamError } from './team_scope';

function failed(res: Response, err: unknown): Response {
  if (err instanceof ToolTeamError) {
    return res.status(400).json({ error: err.message, ...(err.teams ? { teams: err.teams } : {}) });
  }
  const traceId = randomUUID();
  console.error(`[automation-api:${traceId}]`, err);
  return res.status(500).json({ error: 'internal_error', message: 'An internal error occurred.', traceId });
}

function view(inbox: PublicInbox) {
  return {
    key: inbox.key,
    address: inbox.address,
    teamId: inbox.teamId,
    actsAsUserId: inbox.claimedByUserId,
    claimedAt: inbox.createdAt.toISOString(),
  };
}

/** The team a change lands in, when the caller may make it there. */
async function writableTeam(requested: string | undefined): Promise<{ teamId: string } | { refusal: string }> {
  const teamId = await resolveToolTeam(requested);
  const team = (await listAccessibleTeams()).find((candidate) => candidate.teamId === teamId);
  if (team?.access !== 'write') {
    return { refusal: "Only members with write access can change the team's public inboxes." };
  }
  return { teamId };
}

const listSchema = z.object({ team: z.string().optional() });

const listHandler: RequestHandler = async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const teamId = await resolveToolTeam(parsed.data.team);
    return res.status(200).json({ teamId, inboxes: (await listPublicInboxes(teamId)).map(view) });
  } catch (err) {
    return failed(res, err);
  }
};

const changeSchema = z.object({
  key: z.string().min(1),
  team: z.string().optional(),
});

const claimHandler: RequestHandler = async (req, res) => {
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const userId = currentPrincipal().userId;
    if (userId === undefined) {
      return res.status(400).json({
        error:
          'A public inbox acts as the person who claims it when the sender is not on the team, and this connection authenticates as a machine with no person behind it. Claim it with a user-anchored credential.',
      });
    }
    const team = await writableTeam(parsed.data.team);
    if ('refusal' in team) return res.status(403).json({ error: team.refusal });

    const result = await claimPublicInbox({ teamId: team.teamId, key: parsed.data.key, claimedByUserId: userId });
    switch (result.status) {
      case 'claimed':
      case 'already_claimed':
        return res.status(200).json({ status: result.status, inbox: view(result.inbox) });
      case 'held_by_another_team':
        return res.status(409).json({
          error: 'held_by_another_team',
          message: `"${result.key}" is already another team's public inbox. Choose a different key.`,
        });
      case 'invalid_key':
        return res.status(400).json({ error: 'invalid_key', message: `That key cannot be used: ${result.reason}.` });
      default:
        return neverAsAny(result);
    }
  } catch (err) {
    return failed(res, err);
  }
};

const releaseHandler: RequestHandler = async (req, res) => {
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const team = await writableTeam(parsed.data.team);
    if ('refusal' in team) return res.status(403).json({ error: team.refusal });

    const result = await releasePublicInbox({ teamId: team.teamId, key: parsed.data.key });
    switch (result.status) {
      case 'released':
        return res.status(200).json({ status: 'released', key: result.key });
      case 'not_claimed':
        return res.status(404).json({ error: 'not_claimed', message: `"${result.key}" is not a public inbox.` });
      case 'held_by_another_team':
        return res.status(409).json({
          error: 'held_by_another_team',
          message: `"${result.key}" is another team's public inbox; only that team can release it.`,
        });
      default:
        return neverAsAny(result);
    }
  } catch (err) {
    return failed(res, err);
  }
};

function mountPublicInboxRoutes(router: ReturnType<typeof Router>): void {
  router.get('/inboxes', listHandler);
  router.post('/inboxes/claim', claimHandler);
  router.post('/inboxes/release', releaseHandler);
}

export { mountPublicInboxRoutes };
