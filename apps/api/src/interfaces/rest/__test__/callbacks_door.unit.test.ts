// The callback link's door after callbacks were retired (0.13): a link an
// automation sent before then is answered, in place, with the retired text,
// whether it is followed or posted; anything else is no link of ours.

import { createServer, type Server } from 'node:http';

import express from 'express';

import { RETIRED_CALLBACK_TEXT } from '../../../services/interaction/retired_callback';
import { callbacksRouter } from '../callbacks';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/cb', callbacksRouter);
  server = createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the door has no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

describe('a callback link sent before 0.13', () => {
  it('followed: a page that says its button was retired', async () => {
    const res = await fetch(`${baseUrl}/api/cb/cb_abc`);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('This action was retired');
    expect(html).toContain('upgrade the automation');
    expect(html).not.toContain('<form');
  });

  it('posted by a server: the retired text as JSON', async () => {
    const res = await fetch(`${baseUrl}/api/cb/cb_abc`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{"ok":true}' });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ outcome: 'retired', message: RETIRED_CALLBACK_TEXT });
  });

  it('posted from a browser form: the retired page', async () => {
    const res = await fetch(`${baseUrl}/api/cb/cb_abc`, { method: 'POST', headers: { accept: 'text/html' } });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('This action was retired');
  });
});

describe('a link that names no callback', () => {
  it('is not found, followed or posted', async () => {
    expect((await fetch(`${baseUrl}/api/cb/nope`)).status).toBe(404);
    const posted = await fetch(`${baseUrl}/api/cb/nope`, { method: 'POST', headers: { accept: 'application/json' } });
    expect(posted.status).toBe(404);
    expect(await posted.json()).toMatchObject({ outcome: 'not_found' });
  });
});
