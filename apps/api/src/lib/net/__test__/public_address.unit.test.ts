import { isBlockedAddress } from './safe_csv_fetch';

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
});
