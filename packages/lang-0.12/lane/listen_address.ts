// A 0.12 listen's resolved address: production's `listen_address.ts` at 0.12.13
// over 0.12's own module, the position's path and the config's hops, names to
// ids, by the walk. A failed resolution is a save error, never a silently dead
// listen, and a row's identity and its channel are this address.

import type { Adapter, EdgesFromResult, ListenConfigKey } from '@listen-fire/engine/public/adapter';
import { makeMetaPosition, positionLabel, type SourcePosition } from '@listen-fire/engine/public/catalog';

import { manifestOf } from './listen_manifests';
import { moduleTable } from './modules';
import type { ModulePlatform } from './run_types';

/** A wide hop's pages, followed to this many. Production's limit. */
const MAX_WALK_PAGES = 50;

function addressHops(listenConfig: readonly ListenConfigKey[] | undefined): Array<ListenConfigKey & { narrows: NonNullable<ListenConfigKey['narrows']> }> {
  return (listenConfig ?? []).flatMap((key) => (key.narrows !== undefined ? [{ ...key, narrows: key.narrows }] : []));
}

/** A construction argument as the language keeps it: a name may be quoted. */
function unquoted(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length >= 2 && /^(["'`]).*\1$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

async function drainHop(adapter: Adapter, position: SourcePosition): Promise<EdgesFromResult | null> {
  if (adapter.edgesFrom === undefined) return null;
  const first = await adapter.edgesFrom(position);
  if (first === null) return null;
  const references = [...first.descriptor.references];
  const targetPositions = { ...first.targetPositions };
  let cursor = first.nextCursor;
  for (let page = 1; cursor !== undefined && page < MAX_WALK_PAGES; page += 1) {
    const next = await adapter.edgesFrom(position, cursor);
    if (next === null) break;
    references.push(...next.descriptor.references);
    Object.assign(targetPositions, next.targetPositions);
    cursor = next.nextCursor;
  }
  return { ...first, descriptor: { ...first.descriptor, references }, targetPositions };
}

function fieldOf(data: unknown, field: string): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** The label a position argument names a member by: the author types the
 *  member's display label, never its id. */
function memberLabel(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ['Title', 'Name', 'name', 'title']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  for (const value of Object.values(record)) if (typeof value === 'string' && value) return value;
  return undefined;
}

export type AddressResolution = { ok: true; address: Record<string, string> } | { ok: false; reason: string };

export interface AddressRequest {
  teamId: string;
  adapter: string;
  credentialsId: string | null;
  constructionArgs?: Record<string, string>;
  config: Record<string, unknown>;
}

/** Every declared hop resolves, or the whole address fails. An adapter that
 *  declares no hop has no address, and nothing is asked of it. */
export async function resolveListenAddress(request: AddressRequest, modules: ModulePlatform): Promise<AddressResolution> {
  const manifest = manifestOf(request.adapter, modules);
  const hops = addressHops(manifest?.listenConfig);
  if (hops.length === 0) return { ok: true, address: {} };
  const positionValues: Record<string, string> = {};
  for (const arg of manifest?.positionArgs ?? []) {
    const raw = request.constructionArgs?.[arg.name];
    if (raw !== undefined && raw !== '') positionValues[arg.name] = unquoted(raw);
  }
  const adapter = await moduleTable(modules).resolve(request.adapter, {
    teamId: request.teamId,
    ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}),
    ...(request.constructionArgs !== undefined ? { constructionArgs: request.constructionArgs } : {}),
  });
  const address: Record<string, string> = {};
  let hop = await drainHop(adapter, makeMetaPosition(request.adapter));
  for (const { key, narrows } of hops) {
    const configured = request.config[key];
    const configValue = typeof configured === 'string' && configured.length > 0 ? configured : undefined;
    const positionValue = positionValues[key];
    if (configValue === undefined && positionValue === undefined) {
      return { ok: false, reason: `the listen names no '${key}' and the instance isn't positioned at one` };
    }
    const members = Object.values(hop?.targetPositions ?? {}).filter((position) => position.recordType === narrows.collection);
    if (members.length === 0) {
      return { ok: false, reason: `couldn't enumerate the connection's ${narrows.collection} options to resolve '${key}': the connection may be unreachable` };
    }
    const dataOf = (member: SourcePosition): unknown => member.identity.data;
    const fromConfig = configValue !== undefined ? members.find((member) => fieldOf(dataOf(member), narrows.matchField) === configValue) : undefined;
    if (configValue !== undefined && fromConfig === undefined) {
      const known = members.flatMap((member) => fieldOf(dataOf(member), narrows.matchField) ?? []);
      return { ok: false, reason: `'${key}' "${configValue}" isn't one this connection can see: it has ${known.join(', ')}` };
    }
    const fromPosition =
      positionValue !== undefined
        ? members.find((member) => memberLabel(dataOf(member)) === positionValue || fieldOf(dataOf(member), narrows.matchField) === positionValue)
        : undefined;
    if (configValue === undefined && fromPosition === undefined) {
      const known = members.flatMap((member) => memberLabel(dataOf(member)) ?? positionLabel(member) ?? []);
      return { ok: false, reason: `the instance is positioned at '${key}' "${positionValue}", which isn't one this connection can see: it has ${known.join(', ')}` };
    }
    const configResolved = fromConfig !== undefined ? fieldOf(dataOf(fromConfig), narrows.matchField) : undefined;
    const positionResolved = fromPosition !== undefined ? fieldOf(dataOf(fromPosition), narrows.matchField) : undefined;
    if (configResolved !== undefined && positionResolved !== undefined && configResolved !== positionResolved) {
      return {
        ok: false,
        reason: `the listen's '${key}' "${configValue}" disagrees with the instance's position "${positionValue}": a listen's address is relative to the instance's position, so drop the '${key}' from the listen or align them`,
      };
    }
    const value = configResolved ?? positionResolved;
    const chosen = fromConfig ?? fromPosition;
    if (value === undefined || chosen === undefined) {
      return { ok: false, reason: `'${key}' resolved to a member with no '${narrows.matchField}': the adapter published no id for it` };
    }
    address[key] = value;
    hop = await drainHop(adapter, chosen);
  }
  return { ok: true, address };
}
