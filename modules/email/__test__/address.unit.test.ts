// The routing address is the deployment's, and nothing about it is a constant.

import { inboundRoutingAddress, parseRoutingAddress, routingKeyFrom } from '../address';

describe('reading the deployment’s inbound address', () => {
  it('splits it into the parts the config block shows', () => {
    expect(parseRoutingAddress('inbox@example.com')).toEqual({
      localPart: 'inbox',
      domain: 'example.com',
      prefix: 'inbox+',
      suffix: '@example.com',
    });
  });

  it('parses a different deployment’s address just as well', () => {
    expect(parseRoutingAddress('inbox@acme.example')).toMatchObject({
      prefix: 'inbox+',
      suffix: '@acme.example',
    });
  });

  it('refuses an address that already carries a tag — the tag is the key', () => {
    expect(parseRoutingAddress('inbox+already@example.com')).toBeNull();
  });

  it('has no answer at all when nothing is configured', () => {
    expect(parseRoutingAddress(undefined)).toBeNull();
    expect(inboundRoutingAddress({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('finding the routing key on a message', () => {
  const address = parseRoutingAddress('inbox@example.com');

  it('reads the key off the address it was sent to', () => {
    expect(routingKeyFrom(['someone@example.com', 'inbox+deals@example.com'], address)).toBe('deals');
  });

  it('accepts a per-purpose local part', () => {
    expect(routingKeyFrom(['inbox-dealflow+deals@example.com'], address)).toBe('deals');
  });

  it('does not care what case the mail server handed it back in', () => {
    expect(routingKeyFrom(['Inbox+Deals@Example.com'], address)).toBe('Deals');
  });

  it('ignores an address on a domain this deployment does not answer for', () => {
    expect(routingKeyFrom(['inbox+deals@somewhere-else.com'], address)).toBeNull();
  });

  it('treats the dot in the domain as a dot', () => {
    expect(routingKeyFrom(['inbox+deals@exampleXcom'], address)).toBeNull();
  });

  it('finds no key at all when the deployment has no address', () => {
    expect(routingKeyFrom(['inbox+deals@example.com'], null)).toBeNull();
  });
});
