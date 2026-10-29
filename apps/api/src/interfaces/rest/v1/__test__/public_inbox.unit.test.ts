// The public inbox routes the MCP tools call: claiming takes a person (who
// runs act as) and write access on the team, a clash is a 409 that names the
// key but not the team holding it, and releasing is the holding team's alone.

import { createServer, type Server } from 'node:http';

import express, { Router } from 'express';
import { runWithPrincipalSync, type Principal } from 'principal';

import type { AddressInfo } from 'node:net';

const claimPublicInbox = jest.fn();
const releasePublicInbox = jest.fn();
const listPublicInboxes = jest.fn();
let teamAccess: 'read' | 'write' = 'write';

jest.mock('../../../../services/translation_graph/adapters/email/public_inbox', () => ({
  claimPublicInbox: (input: unknown) => claimPublicInbox(input),
  releasePublicInbox: (input: unknown) => releasePublicInbox(input),
  listPublicInboxes: (teamId: string) => listPublicInboxes(teamId),
}));

jest.mock('../team_scope', () => ({
  ...jest.requireActual('../team_scope'),
  resolveToolTeam: async (requested?: string) => requested ?? 'team-1',
  listAccessibleTeams: async () => [{ teamId: 'team-1', name: 'One', access: teamAccess, isPersonal: false }],
}));

import { mountPublicInboxRoutes } from '../public_inbox';

const HUMAN: Principal = { teamId: 'team-1', userId: 'user-1', access: 'write', scopes: ['*'], pinnedTeamId: null };
const MACHINE: Principal = { teamId: 'team-1', access: 'write', scopes: ['*'], pinnedTeamId: 'team-1', credentialId: 'key-1' };

const INBOX = {
  key: 'deals',
  teamId: 'team-1',
  claimedByUserId: 'user-1',
  createdAt: new Date('2026-10-29T00:00:00Z'),
  address: 'inbox+deals@example.com',
};

let acting: Principal = HUMAN;
let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithPrincipalSync(acting, () => next()));
  const router = Router();
  mountPublicInboxRoutes(router);
  app.use('/v1/automation', router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  acting = HUMAN;
  teamAccess = 'write';
});

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}/v1/automation${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('claiming', () => {
  it('claims for the caller’s team, with the caller as who runs act as', async () => {
    claimPublicInbox.mockResolvedValue({ status: 'claimed', inbox: INBOX });

    const res = await post('/inboxes/claim', { key: 'deals' });

    expect(res.status).toBe(200);
    expect(claimPublicInbox).toHaveBeenCalledWith({ teamId: 'team-1', key: 'deals', claimedByUserId: 'user-1' });
    expect(await res.json()).toEqual({
      status: 'claimed',
      inbox: {
        key: 'deals',
        address: 'inbox+deals@example.com',
        teamId: 'team-1',
        actsAsUserId: 'user-1',
        claimedAt: '2026-10-29T00:00:00.000Z',
      },
    });
  });

  it('refuses a key another team holds with a 409 naming the key, not the team', async () => {
    claimPublicInbox.mockResolvedValue({ status: 'held_by_another_team', key: 'deals', teamId: 'team-secret' });

    const res = await post('/inboxes/claim', { key: 'deals' });
    const body = (await res.json()) as { error: string; message: string };

    expect(res.status).toBe(409);
    expect(body.message).toMatch(/"deals" is already another team's public inbox/);
    expect(JSON.stringify(body)).not.toMatch(/team-secret/);
  });

  it('needs a person to act as', async () => {
    acting = MACHINE;

    const res = await post('/inboxes/claim', { key: 'deals' });

    expect(res.status).toBe(400);
    expect(claimPublicInbox).not.toHaveBeenCalled();
  });

  it('needs write access on the team', async () => {
    teamAccess = 'read';

    const res = await post('/inboxes/claim', { key: 'deals' });

    expect(res.status).toBe(403);
    expect(claimPublicInbox).not.toHaveBeenCalled();
  });
});

describe('releasing and listing', () => {
  it('is refused for a key another team holds', async () => {
    releasePublicInbox.mockResolvedValue({ status: 'held_by_another_team', key: 'deals', teamId: 'team-2' });

    const res = await post('/inboxes/release', { key: 'deals' });

    expect(res.status).toBe(409);
  });

  it('releases the team’s own', async () => {
    releasePublicInbox.mockResolvedValue({ status: 'released', key: 'deals' });

    const res = await post('/inboxes/release', { key: 'deals' });

    expect(res.status).toBe(200);
    expect(releasePublicInbox).toHaveBeenCalledWith({ teamId: 'team-1', key: 'deals' });
  });

  it('lists the team’s public inboxes', async () => {
    listPublicInboxes.mockResolvedValue([INBOX]);

    const res = await fetch(`${baseUrl}/v1/automation/inboxes`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ teamId: 'team-1', inboxes: [{ key: 'deals', actsAsUserId: 'user-1' }] });
  });
});
