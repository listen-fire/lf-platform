// What `@lf/ask` describes of itself at 0.12, as production's adapter answered
// `listEntryPoints` and `describe`: the families an ask is written along and
// each family's Response. Writing, reading and answering an ask are the
// module's running half, which this package does not carry.

import type { Adapter } from '@listen-fire/engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor } from '@listen-fire/engine/public/catalog';

import { BaseAdapter } from '@listen-fire/module-kit/adapter/base';

import { familyDescriptor, responseDescriptor, responseTypeFamily, responseTypeId } from './descriptors';
import { ASK_MANIFEST } from './manifest';
import { ASK_ADAPTER_TYPE, ASK_FAMILIES, isAskFamily } from './types';

export class AskSurface extends BaseAdapter implements Adapter {
  readonly adapterType = ASK_ADAPTER_TYPE;
  readonly supportedTriggers = ASK_MANIFEST.supportedTriggers;

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // The families: writable positions on the root, never enumerable.
      ...ASK_FAMILIES.map((family) => ({
        typeId: family,
        displayName: family,
        scope: 'self-configured' as const,
        writable: true,
        readable: false,
      })),
      // Each family's own Response node, reached only by awaiting its edge.
      ...ASK_FAMILIES.map((family) => ({
        typeId: responseTypeId(family),
        displayName: responseTypeId(family),
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      })),
    ];
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    if (isAskFamily(typeId)) return familyDescriptor(typeId);
    const responseFamily = responseTypeFamily(typeId);
    if (responseFamily !== undefined) return responseDescriptor(responseFamily);
    return null;
  }
}
