import * as db from '@prisma/client';
import { InputJsonValue } from '@prisma/client/runtime/library';
import merge from 'lodash/merge';

import { ModelService } from './utils';
import { currentContext } from './context';

type ResourceGetOrCreateParams = {
  type: db.ResourceType;
  name: string;
  url?: string;
  documentId?: string | null;
  rawTextId?: string | null;
  metadata?: InputJsonValue;
  retrievedAt?: Date | null;
  isDemo?: boolean;
  isPrivate: boolean;
};

/**
 * A resource is either the acting team's own (`team_id` set) or shared with
 * everyone (`team_id` null) — the two buckets `getOrCreate` writes into via
 * `isPrivate`. This is the read side of that same rule, and it reproduces
 * exactly what the ability used to apply underneath these queries: the
 * team grant scoped `Resource` to the member's team, and the public grant added the
 * team-less rows on top.
 */
function visibleToActingTeam(teamId: string) {
  return { OR: [{ teamId }, { teamId: null }] };
}

type ResourceUpdateParams = {
  name?: string;
  metadata?: InputJsonValue;
  rawTextId?: string | null;
  documentId?: string | null;
  retrievedAt?: Date | null;
  isDemo?: boolean;
};

class Resource extends ModelService<'resource'> {
  objectName = 'resource' as const;

  async getOrCreate(params: ResourceGetOrCreateParams) {
    const ctx = currentContext();
    let resource;
    if (params.url) {
      const existing = await this.model.findFirst({
        where: {
          url: params.url,
          type: params.type,
          teamId: params.isPrivate ? ctx.user.teamId : null,
        },
      });

      if (existing) {
        const metadata = merge({}, existing.metadata, params.metadata);
        // `existing` came out of the team-scoped read above, so updating it by
        // id writes inside the tenant the read already established.
        resource = await this.model.update({
          where: {
            id: existing.id,
          },
          data: {
            metadata,
            // name: params.name, // don't update name
            rawTextId: params.rawTextId,
            documentId: params.documentId,
            retrievedAt: params.retrievedAt,
            isDemo: params.isDemo,
          },
        });
      }
    }

    if (!resource) {
      resource = await this.model.create({
        data: {
          type: params.type,
          name: params.name,
          url: params.url,
          documentId: params.documentId,
          rawTextId: params.rawTextId,
          metadata: params.metadata,
          retrievedAt: params.retrievedAt,
          isDemo: params.isDemo,
          teamId: params.isPrivate ? ctx.user.teamId : null,
          createdBy: ctx.user.id,
        },
      });
    }

    return resource;
  }

  async update(id: string, params: ResourceUpdateParams) {
    const ctx = currentContext();
    // Establish the tenant with the read, then write by the id it returned —
    // the same order `getOrCreate` uses. `update` alone takes only a unique
    // where, so the condition has nowhere else to go.
    const existing = await this.model.findFirstOrThrow({
      where: {
        id,
        ...visibleToActingTeam(ctx.user.teamId),
      },
    });

    return this.model.update({
      where: {
        id: existing.id,
      },
      data: params,
    });
  }

  // `linkToLegalEntity`, `linkToInvestorUpdate`, `findManyByLegalEntityId` and
  // the parentId branch of `getOrCreate` that wrote the resource-segment join
  // row were DELETED here — zero callers, over the resource-segment,
  // legal-entity-resource, investor-update-resource and investor-update
  // tables, which the migration squash dropped for the same reason.
  // `findManyByLegalEntityId` had already gone dead earlier, when the
  // source-material move dissolved its Prisma relation (the FK went
  // cross-schema).
}

const ResourceService = new Resource();

export { ResourceService };
