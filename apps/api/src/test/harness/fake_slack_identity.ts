// A Slack that answers only who the app is and what a channel is called: what
// the Slack module looks up while it reads a delivery, so a test of a
// connection's settings can send the app's own messages and members' alike.

import { createServer, type Server } from 'node:http';

export const FAKE_SLACK_APP_USER = 'UAPP';
export const FAKE_SLACK_APP_BOT = 'BAPP';

export async function fakeSlackIdentity(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop();
      const answer =
        method === 'auth.test'
          ? { ok: true, user_id: FAKE_SLACK_APP_USER, bot_id: FAKE_SLACK_APP_BOT, team_id: 'T1' }
          : method === 'conversations.info'
            ? { ok: true, channel: { id: 'C1', name: 'deals' } }
            : { ok: false, error: 'unknown_method' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake Slack has no port');
  return { baseUrl: `http://127.0.0.1:${address.port}/api/`, close: () => new Promise((done) => server.close(() => done())) };
}
