// The OAuth redirect relay: a provider's redirect to the platform is handed
// to the team's `lf serve`, which answers as `deliver_public_redirect` does
// (crates/lf/src/oauth_signin.rs): 400 with no state, 404 when no command is
// waiting, 200 when one is. The query carries the sign-in's code, so nothing
// here logs it and the request logger never sees the route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import express from 'express';
import { logger } from 'movement-engine/public/log';

import type { AddressInfo } from 'node:net';

import { assertLfOAuthRelayConfigured, createLfOAuthRelayRouter } from '../lfSecrets';

const TEAM = '11111111-1111-1111-1111-111111111111';

const listen = (server: Server): Promise<string> =>
  new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** A stand-in `lf serve`: its GET /oauth/callback, answering as lf does. */
const lfQueries: string[] = [];
let lfAnswer: { status: number; text: string } | undefined;
const lfServe = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', 'http://lf');
  if (url.pathname !== '/oauth/callback') {
    response.writeHead(404).end();
    return;
  }
  lfQueries.push(url.search.slice(1));
  const state = url.searchParams.get('state');
  const answer =
    lfAnswer ??
    (state === null || state === ''
      ? { status: 400, text: 'This redirect carries no state.' }
      : state === 'waiting'
        ? { status: 200, text: 'lf has the sign-in. Return to the terminal where `lf credential` is waiting.' }
        : { status: 404, text: 'No `lf credential` command is waiting for this sign-in; start it again.' });
  response.writeHead(answer.status, { 'content-type': 'text/plain' }).end(answer.text);
});

/** What reached the middleware mounted after the relay, as the request logger is. */
const reachedLater: string[] = [];
const app = express();
app.use('/api/public/lf-secrets', createLfOAuthRelayRouter());
app.use((req, res) => {
  reachedLater.push(req.originalUrl);
  res.status(418).end();
});
const platform = createServer(app);

let lfUrl: string;
let platformUrl: string;
const logged: unknown[][] = [];

beforeAll(async () => {
  lfUrl = await listen(lfServe);
  platformUrl = await listen(platform);
});

afterAll(async () => {
  await new Promise((done) => lfServe.close(done));
  await new Promise((done) => platform.close(done));
});

beforeEach(() => {
  lfQueries.length = 0;
  reachedLater.length = 0;
  logged.length = 0;
  lfAnswer = undefined;
  process.env.LF_OAUTH_RELAY_TARGETS = JSON.stringify({ [TEAM]: lfUrl });
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});

afterEach(() => {
  delete process.env.LF_OAUTH_RELAY_TARGETS;
  jest.restoreAllMocks();
});

const relay = async (team: string, query: string) => {
  const answer = await fetch(`${platformUrl}/api/public/lf-secrets/oauth/callback/${team}${query === '' ? '' : `?${query}`}`);
  return { status: answer.status, text: await answer.text() };
};

const expectNothingLoggedOrPassedOn = () => {
  expect(JSON.stringify(logged)).not.toMatch(/code=|c1|state=/);
  expect(reachedLater).toEqual([]);
};

describe('the OAuth redirect relay', () => {
  it('hands a waiting sign-in to lf and shows lf\'s answer', async () => {
    const answer = await relay(TEAM, 'code=c1&state=waiting');
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('lf has the sign-in.');
    expect(lfQueries).toEqual(['code=c1&state=waiting']);
    expectNothingLoggedOrPassedOn();
  });

  it('refuses a state no waiting lf started, with a fixed text', async () => {
    const answer = await relay(TEAM, 'code=c1&state=nobody');
    expect(answer).toEqual({ status: 404, text: 'This sign-in is not one a waiting lf started' });
    expectNothingLoggedOrPassedOn();
  });

  it('answers a redirect without its state 400, without forwarding it', async () => {
    expect((await relay(TEAM, 'code=c1')).status).toBe(400);
    expect((await relay(TEAM, 'code=c1&state=')).status).toBe(400);
    expect(lfQueries).toEqual([]);
    expectNothingLoggedOrPassedOn();
  });

  it('answers a team with no lf configured 404, without forwarding', async () => {
    expect((await relay('22222222-2222-2222-2222-222222222222', 'code=c1&state=waiting')).status).toBe(404);
    expect(lfQueries).toEqual([]);
    expectNothingLoggedOrPassedOn();
  });

  it('passes lf\'s 400 through, and answers anything else lf says 502', async () => {
    lfAnswer = { status: 400, text: 'This redirect carries no state.' };
    expect(await relay(TEAM, 'code=c1&state=s1')).toEqual({ status: 400, text: 'This redirect carries no state.' });
    lfAnswer = { status: 500, text: 'disk full at /home/lf/.lf/oauth' };
    const failed = await relay(TEAM, 'code=c1&state=s1');
    expect(failed.status).toBe(502);
    expect(failed.text).not.toContain('disk full');
    expectNothingLoggedOrPassedOn();
  });

  it('answers 502 when lf cannot be reached', async () => {
    process.env.LF_OAUTH_RELAY_TARGETS = JSON.stringify({ [TEAM]: 'http://127.0.0.1:1' });
    expect((await relay(TEAM, 'code=c1&state=waiting')).status).toBe(502);
    expectNothingLoggedOrPassedOn();
  });
});

describe('LF_OAUTH_RELAY_TARGETS at boot', () => {
  it('accepts no relay, and https targets in production', () => {
    expect(() => assertLfOAuthRelayConfigured({})).not.toThrow();
    expect(() => assertLfOAuthRelayConfigured({ NODE_ENV: 'production', LF_OAUTH_RELAY_TARGETS: JSON.stringify({ [TEAM]: 'https://lf.example.com' }) })).not.toThrow();
  });

  it('fails a bad value, naming the variable', () => {
    for (const value of ['not json', '[]', JSON.stringify({ [TEAM]: 7 }), JSON.stringify({ [TEAM]: 'not a url' }), JSON.stringify({ [TEAM]: 'ftp://lf.example.com' })]) {
      expect(() => assertLfOAuthRelayConfigured({ LF_OAUTH_RELAY_TARGETS: value })).toThrow(/LF_OAUTH_RELAY_TARGETS/);
    }
  });

  it('refuses a plain-http target in production', () => {
    expect(() => assertLfOAuthRelayConfigured({ NODE_ENV: 'production', LF_OAUTH_RELAY_TARGETS: JSON.stringify({ [TEAM]: 'http://lf.example.com' }) })).toThrow(/LF_OAUTH_RELAY_TARGETS.*https/);
  });
});
