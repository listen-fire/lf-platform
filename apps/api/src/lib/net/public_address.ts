// Which addresses a request to a URL someone else supplied may reach: public
// ones only. A URL a user or a model hands the platform could otherwise be
// steered at cloud metadata (169.254.169.254), internal services or the
// loopback interface. Shared by every outbound request whose target is not
// ours: the CSV import (`knowledge/safe_csv_fetch.ts`) and the requests to a
// connected MCP server (`public_fetch.ts`).

import { isIP } from 'node:net';
import dns from 'node:dns';

/** Every address a hostname resolves to (a literal IP resolves to itself). */
export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemLookup: HostLookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** True if `int` falls inside the CIDR block `base/prefix`. */
function inRange(int: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (int & mask) === (baseInt & mask);
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function isBlockedIpv4(ip: string): boolean {
  const int = ipv4ToInt(ip);
  if (int === null) return true; // unparseable → treat as blocked, fail closed
  return BLOCKED_IPV4.some(([base, prefix]) => inRange(int, base, prefix));
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) → run the IPv4 checks.
  const mappedPrefix = '::ffff:';
  if (lower.startsWith(mappedPrefix)) {
    const rest = lower.slice(mappedPrefix.length);
    if (rest.includes('.')) {
      return isBlockedIpv4(rest);
    }
    // ::ffff:xxxx:xxxx hextet form — reconstruct the dotted quad.
    const hextets = rest.split(':');
    if (hextets.length === 2) {
      const high = parseInt(hextets[0], 16);
      const low = parseInt(hextets[1], 16);
      if (!Number.isNaN(high) && !Number.isNaN(low)) {
        const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return isBlockedIpv4(dotted);
      }
    }
  }

  if (lower === '::1') return true; // loopback
  if (lower === '::') return true; // unspecified

  const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
  if (Number.isNaN(firstHextet)) return true; // fail closed

  // fc00::/7 — unique local (first 7 bits are 1111110)
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local (first 10 bits are 1111111010)
  if ((firstHextet & 0xffc0) === 0xfe80) return true;

  return false;
}

/**
 * True if `ip` is a literal IP address in a private, loopback, link-local, or
 * otherwise reserved range that a URL someone else supplied must not reach.
 * Pure and network-free.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP literal → fail closed
}

/** A host refused because it is, or resolves to, an address that is not public. */
export class NonPublicAddress extends Error {
  constructor(hostname: string, address?: string) {
    super(
      address === undefined || address === hostname
        ? `${hostname} is not a public address, so it is not reached.`
        : `${hostname} resolves to ${address}, which is not a public address, so it is not reached.`,
    );
    this.name = 'NonPublicAddress';
  }
}

/** The host's addresses, refused when any of them is not public (or when it
 *  resolves to nothing). URL hostnames keep IPv6 literals in brackets. */
export async function publicAddressesOf(
  hostname: string,
  lookup: HostLookup = systemLookup,
): Promise<Array<{ address: string; family: number }>> {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const literal = isIP(bare);
  if (literal !== 0) {
    if (isBlockedAddress(bare)) throw new NonPublicAddress(bare);
    return [{ address: bare, family: literal }];
  }
  const resolved = await lookup(bare);
  if (resolved.length === 0) throw new NonPublicAddress(bare);
  const blocked = resolved.find(({ address }) => isBlockedAddress(address));
  if (blocked !== undefined) throw new NonPublicAddress(bare, blocked.address);
  return resolved;
}
