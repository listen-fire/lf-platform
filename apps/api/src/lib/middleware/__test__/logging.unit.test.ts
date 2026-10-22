// The request log never carries an OAuth callback's query: its `code` and
// `state` are a sign-in in flight, and the log line names every request's URL.

import { createServer, type Server } from 'node:http';

import express from 'express';
import winston from 'winston';

import type { AddressInfo } from 'node:net';

import { expressLogger, loggedUrl } from '../logging';

describe('loggedUrl', () => {
  it('drops the query of a URL carrying a code or a state', () => {
    expect(loggedUrl('/api/oauth/callback?code=c1&state=s1')).toBe('/api/oauth/callback?[redacted]');
    expect(loggedUrl('/api/public/connect/callback?state=s1')).toBe('/api/public/connect/callback?[redacted]');
    expect(loggedUrl('/x?error=access_denied&code=c1')).toBe('/x?[redacted]');
  });

  it('keeps every other URL as it is', () => {
    expect(loggedUrl('/api/trpc/views.list?batch=1')).toBe('/api/trpc/views.list?batch=1');
    expect(loggedUrl('/api/files/abc')).toBe('/api/files/abc');
    expect(loggedUrl('/x?postcode=E1&statement=1')).toBe('/x?postcode=E1&statement=1');
  });
});

describe('the request logger', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(expressLogger);
    // As in the app: the body parser after the logger gives every request a body.
    app.use(express.json());
    app.get('/api/oauth/callback', (_req, res) => {
      res.status(200).send('ok');
    });
    server = createServer(app);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  it('writes an OAuth callback\'s line without its code or state', async () => {
    const written: string[] = [];
    const transport = jest.spyOn(winston.transports.Console.prototype, 'log').mockImplementation((info: unknown, ...rest: unknown[]) => {
      written.push(JSON.stringify(info));
      const [done] = rest;
      if (typeof done === 'function') done();
    });
    try {
      await (await fetch(`${url}/api/oauth/callback?code=secret-code-c1&state=secret-state-s1`)).text();
      // The line is written when the response finishes.
      await new Promise((done) => setTimeout(done, 50));
    } finally {
      transport.mockRestore();
    }
    const line = written.join('\n');
    expect(line).toContain('/api/oauth/callback?[redacted]');
    expect(line).not.toContain('secret-code-c1');
    expect(line).not.toContain('secret-state-s1');
  });
});
