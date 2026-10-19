// A deterministic stand-in for the two Mailgun endpoints email reaches, for
// RECORDING the parity fixture only (fake-channels has no Mailgun): a stored
// attachment's bytes, which need the account's key, and the send.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function bootMailgunFake(apiKey: string): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const expected = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
  let sent = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Invalid private key' }));
        return;
      }
      const path = req.url ?? '/';
      if (req.method === 'GET' && /^\/v3\/domains\/[^/]+\/messages\/[^/]+\/attachments\/\d+$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(`bytes of ${path}`);
        return;
      }
      if (req.method === 'POST' && /^\/v3\/[^/]+\/messages$/.test(path)) {
        sent += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `<parity-${sent}@example.com>`, message: 'Queued. Thank you.' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
