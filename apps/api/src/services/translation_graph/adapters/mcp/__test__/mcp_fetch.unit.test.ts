// The fetch an MCP connection's requests go through asks the platform's
// limiter, so a server's 429 holds that connection's next requests on every
// instance sharing the limiter, as a remote module's throttle does.

import http from 'node:http';

import { MemoryLimiter, installLimiter, limitRequest, limiterSlot } from 'movement-engine/public/limiter';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { mcpServerFetch } from '..';

const TEAM = '00000000-0000-4000-8000-000000000001' as TeamId;

it('throttles the connection when its server answers 429, for as long as Retry-After says', async () => {
  installLimiter(new MemoryLimiter());
  const server = http.createServer((_request, response) => {
    response.writeHead(429, { 'retry-after': '30' });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the test server has no port');
    const send = mcpServerFetch({ teamId: TEAM, credentialsId: 'cred-1' }, {});

    const response = await send(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(429);
    const sameConnection = await limiterSlot().acquire(limitRequest({ module: 'mcp', team: TEAM, install: 'cred-1', credential: 'cred-1' }, []));
    expect(sameConnection.granted).toBe(false);
    expect(sameConnection.granted === false && Date.parse(sameConnection.retryAt) - Date.now()).toBeGreaterThan(25_000);
    const otherConnection = await limiterSlot().acquire(limitRequest({ module: 'mcp', team: TEAM, install: 'cred-2', credential: 'cred-2' }, []));
    expect(otherConnection.granted).toBe(true);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
