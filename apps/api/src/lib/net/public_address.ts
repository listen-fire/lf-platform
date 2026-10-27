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
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, the cloud metadata address among them
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast included
];

function isBlockedIpv4(ip: string): boolean {
  const int = ipv4ToInt(ip);
  if (int === null) return true; // unparseable → treat as blocked, fail closed
  return BLOCKED_IPV4.some(([base, prefix]) => inRange(int, base, prefix));
}

/** The eight 16-bit groups of a valid IPv6 literal, however it is written
 *  (compressed, expanded, or with a dotted IPv4 tail). */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const int = ipv4ToInt(dotted[2]!);
    if (int === null) return null;
    text = `${dotted[1]}${(int >>> 16).toString(16)}:${(int & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** The IPv4 address held in two groups of an IPv6 one. */
function embeddedIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (groups === null) return true; // fail closed
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroTo = (count: number) => groups.slice(0, count).every((group) => group === 0);

  // ::/96 — unspecified, loopback, and the retired IPv4-compatible form.
  if (zeroTo(6)) return true;
  // ::ffff:0:0/96 — an IPv4 address written as IPv6: the IPv4 rules decide.
  if (zeroTo(5) && g5 === 0xffff) return isBlockedIpv4(embeddedIpv4(g6, g7));
  // ::ffff:0:0:0/96 — the translated IPv4 form (SIIT).
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return isBlockedIpv4(embeddedIpv4(g6, g7));
  // 64:ff9b::/96 — NAT64 of an IPv4 address: the IPv4 rules decide.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedIpv4(embeddedIpv4(g6, g7));
  // 64:ff9b:1::/48 — NAT64 for local networks.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 100::/64 — discard.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001::/32 Teredo and 2001:db8::/32 documentation.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  // 2002::/16 — 6to4, whose next 32 bits are an IPv4 address.
  if (g0 === 0x2002) return isBlockedIpv4(embeddedIpv4(g1, g2));
  // fc00::/7 — unique local (fd00:ec2::254, the AWS metadata address, among them).
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local and fec0::/10 site-local.
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 — multicast.
  if ((g0 & 0xff00) === 0xff00) return true;

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

/** The names clouds give their instance metadata service. */
const METADATA_HOSTNAMES: ReadonlySet<string> = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);

/** The code module-kit's retrying fetch reads to stop at once: a refusal by
 *  policy is the same on every attempt. Matched by value, so it needs no
 *  module-kit release that exports it. */
export const POLICY_REFUSAL_CODE = 'LF_POLICY_REFUSAL';

/** A host refused because it is, or resolves to, an address that is not public. */
export class NonPublicAddress extends Error {
  readonly code = POLICY_REFUSAL_CODE;
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
  // Refused by name as well as by address: inside a cloud they resolve to the
  // metadata address, but a resolver elsewhere may answer something else.
  if (METADATA_HOSTNAMES.has(bare.toLowerCase().replace(/\.+$/, ''))) throw new NonPublicAddress(bare);
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
