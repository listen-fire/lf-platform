import { isBlockedAddress, publicAddressesOf } from '../public_address';

describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local, and reserved IPv4', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('192.168.0.5')).toBe(true);
    expect(isBlockedAddress('172.16.5.5')).toBe(true);
    expect(isBlockedAddress('100.64.1.1')).toBe(true);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
  });

  it('blocks loopback and link-local IPv6 (incl. IPv4-mapped)', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('blocks carrier-grade NAT, multicast, broadcast and documentation IPv4', () => {
    for (const ip of ['100.64.0.1', '100.127.255.254', '224.0.0.1', '239.255.255.250', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9']) {
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, true]);
    }
  });

  it('blocks unique-local, site-local, multicast and the AWS IPv6 metadata address', () => {
    for (const ip of ['fd00:ec2::254', 'fc00::1', 'fdff:ffff::1', 'fec0::1', 'ff02::1', 'ff05::1:3', '::', '2001:db8::1', '2001::1', '100::1']) {
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, true]);
    }
  });

  it('reads an IPv4 address embedded in IPv6 however it is written, and holds it to the IPv4 rules', () => {
    for (const ip of [
      '0:0:0:0:0:ffff:7f00:1', // mapped, expanded
      '::ffff:a9fe:a9fe', // mapped, hex: 169.254.169.254
      '::ffff:0:a9fe:a9fe', // translated (SIIT)
      '::127.0.0.1', // the retired IPv4-compatible form
      '::a9fe:a9fe',
      '64:ff9b::169.254.169.254', // NAT64
      '64:ff9b::a00:1', // NAT64 of 10.0.0.1
      '64:ff9b:1::1', // NAT64 for local networks
      '2002:a9fe:a9fe::1', // 6to4 of 169.254.169.254
      '2002:c0a8:0101::1', // 6to4 of 192.168.1.1
    ]) {
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, false]);
    }
  });
});

describe('publicAddressesOf', () => {
  const resolving = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];

  it('refuses the cloud metadata names without resolving them, whatever a resolver would say', async () => {
    const lookup = jest.fn(resolving('93.184.216.34'));
    for (const name of ['metadata.google.internal', 'METADATA.GOOGLE.INTERNAL', 'metadata.google.internal.', 'metadata', 'metadata.goog']) {
      await expect(publicAddressesOf(name, lookup)).rejects.toThrow(/is not a public address/);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a name whose AAAA record is the AWS IPv6 metadata address or a multicast one', async () => {
    await expect(publicAddressesOf('a.example', resolving('fd00:ec2::254'))).rejects.toThrow('a.example resolves to fd00:ec2::254');
    await expect(publicAddressesOf('b.example', resolving('ff02::1'))).rejects.toThrow('b.example resolves to ff02::1');
    await expect(publicAddressesOf('[fd00:ec2::254]', resolving('8.8.8.8'))).rejects.toThrow('fd00:ec2::254 is not a public address');
  });
});
