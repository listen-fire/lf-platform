// The fetch an MCP connection's requests go through: https to public addresses
// only, checked before any request and again when the connection opens. A stub
// resolver stands in for DNS, and a stub fetch for the network, so nothing here
// leaves the machine.

import http from 'node:http';

import { Agent } from 'undici';

import type { HostLookup } from '../public_address';
import { RefusedUrl, publicFetch, publicOnlyLookup, urlRefusal } from '../public_fetch';

const PRODUCTION = { NODE_ENV: 'production' };

function resolvingTo(addresses: Record<string, string[]>): HostLookup & { asked: string[] } {
  const asked: string[] = [];
  const lookup = async (hostname: string) => {
    asked.push(hostname);
    return (addresses[hostname] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return Object.assign(lookup, { asked });
}

function stubFetch(answer: () => Response = () => new Response('{}', { status: 200 })) {
  return jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () => answer());
}

describe('publicFetch', () => {
  it('refuses a host that resolves to a private address before any request', async () => {
    const lookup = resolvingTo({ 'mcp.internal.example': ['10.0.0.5'] });
    const send = stubFetch();
    const guarded = publicFetch({ env: PRODUCTION, lookup, fetch: send });

    await expect(guarded('https://mcp.internal.example/mcp', { method: 'POST' })).rejects.toThrow(
      new RefusedUrl('mcp.internal.example resolves to 10.0.0.5, which is not a public address, so it is not reached.'),
    );
    expect(lookup.asked).toEqual(['mcp.internal.example']);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a host when any one of its addresses is private', async () => {
    const lookup = resolvingTo({ 'split.example': ['93.184.216.34', '127.0.0.1'] });
    const send = stubFetch();
    const guarded = publicFetch({ env: PRODUCTION, lookup, fetch: send });

    await expect(guarded('https://split.example/mcp')).rejects.toThrow(/resolves to 127\.0\.0\.1/);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses the metadata address and other private literals without resolving them', async () => {
    const lookup = resolvingTo({});
    const send = stubFetch();
    const guarded = publicFetch({ env: PRODUCTION, lookup, fetch: send });

    for (const url of [
      'https://169.254.169.254/latest/meta-data',
      'https://[fd00:ec2::254]/latest/meta-data',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://192.168.1.10/mcp',
      'https://100.64.0.1/mcp',
      'https://224.0.0.1/mcp',
      'https://[::1]/mcp',
      'https://[fe80::1]/mcp',
      'https://[fd12:3456::1]/mcp',
      'https://[ff02::1]/mcp',
      'https://[::ffff:169.254.169.254]/mcp',
    ]) {
      await expect(guarded(url)).rejects.toThrow(/is not a public address/);
    }
    expect(lookup.asked).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses http in production, localhost included', async () => {
    const lookup = resolvingTo({ 'mcp.example.com': ['93.184.216.34'] });
    const send = stubFetch();
    const guarded = publicFetch({ env: PRODUCTION, lookup, fetch: send });

    await expect(guarded('http://mcp.example.com/mcp')).rejects.toThrow('the URL must be https (http is reached only for localhost, in development).');
    await expect(guarded('http://localhost:4000/mcp')).rejects.toThrow('the URL must be https (http is reached only for localhost, in development).');
    expect(lookup.asked).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('reaches localhost over http only in development and test', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const send = stubFetch();
      const guarded = publicFetch({ env: { NODE_ENV }, lookup: resolvingTo({}), fetch: send });
      await guarded('http://127.0.0.1:4000/mcp');
      await guarded('http://localhost:4000/mcp');
      expect(send).toHaveBeenCalledTimes(2);
      // Any other http host is still refused there.
      await expect(guarded('http://mcp.example.com/mcp')).rejects.toThrow('the URL must be https (http is reached only for localhost, in development).');
    }
    const staging = publicFetch({ env: { NODE_ENV: 'staging' }, lookup: resolvingTo({}), fetch: stubFetch() });
    await expect(staging('http://localhost:4000/mcp')).rejects.toThrow('the URL must be https (http is reached only for localhost, in development).');
  });

  it('sends https to a public host, connecting through the address-checking agent and not following redirects', async () => {
    const lookup = resolvingTo({ 'mcp.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
    const send = stubFetch();
    const guarded = publicFetch({ env: PRODUCTION, lookup, fetch: send });

    const response = await guarded('https://mcp.example.com/mcp', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://mcp.example.com/mcp');
    expect(init).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual' });
    expect(init && 'dispatcher' in init && init.dispatcher instanceof Agent).toBe(true);
  });

  it('refuses a redirect rather than following it', async () => {
    const lookup = resolvingTo({ 'mcp.example.com': ['93.184.216.34'] });
    const send = stubFetch(() => new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/' } }));
    const guarded = publicFetch({ env: PRODUCTION, lookup, fetch: send });

    await expect(guarded('https://mcp.example.com/mcp')).rejects.toThrow(
      'it answered with a redirect to http://169.254.169.254/; redirects are not followed, so connect the URL it redirects to.',
    );
  });

  it('refuses a redirect from localhost in development too, rather than following it', async () => {
    const send = stubFetch(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    const guarded = publicFetch({ env: { NODE_ENV: 'development' }, lookup: resolvingTo({}), fetch: send });

    await expect(guarded('http://localhost:4000/mcp')).rejects.toThrow(/redirects are not followed/);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses each redirect hop of the real fetch, so a public server cannot bounce a request inward', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data' });
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('the test server has no port');
      const { port } = address;
      const guarded = publicFetch({ env: { NODE_ENV: 'test' }, lookup: resolvingTo({}) });
      await expect(guarded(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow(
        'it answered with a redirect to http://169.254.169.254/latest/meta-data; redirects are not followed, so connect the URL it redirects to.',
      );
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it('refuses at connect time a name that resolved to a public address for the check and a private one after (DNS rebinding)', async () => {
    let answers = 0;
    const rebinding: HostLookup = async () => [{ address: answers++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    // The global fetch, so the agent's own resolver is what opens (here,
    // refuses) the connection: nothing is sent anywhere.
    const guarded = publicFetch({ env: PRODUCTION, lookup: rebinding });

    const failure = await guarded('https://rebind.example/mcp').then(
      () => undefined,
      (error: unknown) => error,
    );

    // undici's own failure, from another realm than the test's, so read by name.
    expect(String(failure)).toBe('TypeError: fetch failed');
    expect(String(Reflect.get(Object(failure), 'cause'))).toContain('rebind.example resolves to 127.0.0.1, which is not a public address');
    expect(answers).toBe(2);
  });
});

describe('publicOnlyLookup', () => {
  it('answers the public addresses in either form net asks for, and refuses a private one', async () => {
    const lookup = publicOnlyLookup(resolvingTo({ 'ok.example': ['93.184.216.34'], 'bad.example': ['10.1.2.3'] }));
    const ask = (hostname: string, all: boolean) =>
      new Promise((done) => lookup(hostname, { all }, (error, address, family) => done({ error: error?.message, address, family })));

    expect(await ask('ok.example', true)).toEqual({ error: undefined, address: [{ address: '93.184.216.34', family: 4 }], family: undefined });
    expect(await ask('ok.example', false)).toEqual({ error: undefined, address: '93.184.216.34', family: 4 });
    expect(await ask('bad.example', false)).toMatchObject({ error: 'bad.example resolves to 10.1.2.3, which is not a public address, so it is not reached.' });
  });
});

describe('urlRefusal', () => {
  it('names what is wrong with a URL before anything is stored', () => {
    expect(urlRefusal('https://mcp.example.com/mcp', { label: 'MCP server', env: PRODUCTION })).toBeUndefined();
    expect(urlRefusal('http://mcp.example.com/mcp', { label: 'MCP server', env: PRODUCTION })).toBe(
      'MCP server URL "http://mcp.example.com/mcp" must be https (http is reached only for localhost, in development).',
    );
    expect(urlRefusal('mcp.example.com', { label: 'MCP server', env: PRODUCTION })).toBe('MCP server URL "mcp.example.com" is not a URL.');
    expect(urlRefusal('ftp://mcp.example.com', { label: 'MCP server', env: PRODUCTION })).toMatch(/must be https/);
  });
});
