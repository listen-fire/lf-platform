// The platform's store for `@lf/kg`: the knowledge unit, reached the way it
// has been since D25 — over its HTTP surface with the install's stored
// credential (a loopback hop on the composed deployment) — plus this side's
// own `public.resource` rows, which only the platform has. One store per
// install, scoped to the install's team and connection, so the module never
// names either.
//
// The store's wire vocabulary lives here and not in the module: how a write's
// provenance is recorded (its evidence type, the change feed's source) and how
// an external adapter type is spelled on a bridge are the store's own.

import type { ModuleContext } from 'module-kit';
import type { KgPropertyWrite, KgStore } from '@listen-fire/kg/store';
import type { MutationContext, MutationSourceType } from 'movement-engine/public/adapter';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type { TeamId } from '../../../generated/kysely/core/Team';

import ChangeSource from '../../../generated/kysely/knowledge/ChangeSource';
import EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import { teamIdSchema } from '../../../lib/team_id';
import { normalizeAdapterType } from '../../knowledge_pipeline/output_v3/linked_objects';
import { kgFetch, kgFetchOrNull, loadKgCredentials, type KgCredentials, type WireOntology } from './kg_client';
import { persistKgResources, readKgResources } from './knowledge_graph_resources';
import { deregisterKnowledgeWebhook, registerKnowledgeWebhook } from './knowledge_graph_webhook';

/** The store for the install a module context was built for. */
export function platformKgStoreFor(ctx: ModuleContext): KgStore {
  return platformKgStore({ teamId: teamIdSchema.parse(ctx.config.tenant), credentialsId: ctx.config.credentialRef });
}

/**
 * One install's store. A missing connection is a hard error on the first read
 * or write rather than a graceful empty: the graph is optional, and a team
 * without a connection has no `kg` in its catalog — so reaching here without
 * one means something constructed an install it had no right to, and
 * answering "the graph is empty" would be a lie that looks like data.
 */
export function platformKgStore(install: { teamId: TeamId; credentialsId: string | undefined }): KgStore {
  const team = install.teamId;
  const creds = async (): Promise<KgCredentials> => {
    if (install.credentialsId === undefined) {
      throw new Error(
        'The knowledge graph adapter has no connection. Connect Listen-Fire Knowledge for this team, then re-save the movement.',
      );
    }
    return loadKgCredentials(install.credentialsId);
  };

  return {
    async ontology() {
      return kgFetch<WireOntology>(await creds(), { method: 'GET', path: '/ontology', query: { team } });
    },

    async nodeTypesOf(nodeIds) {
      const batch = await kgFetch<{ data: { id: string; nodeTypeId: string }[] }>(await creds(), {
        method: 'POST',
        path: '/nodes/batch',
        body: { ids: nodeIds, team },
      });
      return batch.data;
    },

    async matchNodes(input) {
      const { candidates } = await kgFetch<{ candidates: Awaited<ReturnType<KgStore['matchNodes']>> }>(await creds(), {
        method: 'POST',
        path: '/nodes/match',
        body: { nodeTypeId: input.nodeTypeId, record: input.record, team },
      });
      return candidates;
    },

    async getNode(nodeId) {
      return kgFetchOrNull(await creds(), { method: 'GET', path: `/nodes/${nodeId}`, query: { team } });
    },

    async listNodeIds(input) {
      const page = await kgFetch<{ data: { id: string }[] }>(await creds(), {
        method: 'GET',
        path: '/nodes',
        query: { team, nodeTypeId: input.nodeTypeId, limit: input.limit, offset: input.offset },
      });
      return page.data.map((n) => n.id);
    },

    async edgesOf(input) {
      const { data } = await kgFetch<{ data: Awaited<ReturnType<KgStore['edgesOf']>> }>(await creds(), {
        method: 'GET',
        path: `/nodes/${input.nodeId}/edges`,
        query: { team, edgeTypeId: input.edgeTypeId, direction: input.direction },
      });
      return data;
    },

    async resourcesOf(nodeId) {
      const attached = await kgFetch<{ data: { resourceId: string }[] }>(await creds(), {
        method: 'GET',
        path: `/nodes/${nodeId}/resources`,
        query: { team },
      });
      return readKgResources(attached.data.map((r) => r.resourceId as ResourceId));
    },

    async createNode(input) {
      return kgFetch<{ nodeId: string }>(await creds(), {
        method: 'POST',
        path: '/nodes',
        body: {
          nodeTypeId: input.nodeTypeId,
          properties: input.properties,
          edges: input.edges,
          bridge: input.bridge
            ? {
                adapterType: normalizeAdapterType(input.bridge.adapterType),
                externalId: input.bridge.externalId,
                externalObjectType: input.bridge.externalObjectType ?? null,
              }
            : undefined,
          ...writeProvenance(input.mutationContext),
        },
      });
    },

    async updateNode(input) {
      return kgFetchOrNull<{ nodeId: string }>(await creds(), {
        method: 'PATCH',
        path: `/nodes/${input.nodeId}`,
        body: { properties: input.properties, ...writeProvenance(input.mutationContext) },
      });
    },

    async assertEdge(input) {
      return kgFetch<{ edgeId: string; created: boolean }>(await creds(), {
        method: 'POST',
        path: '/edges',
        body: edgeBody(input),
      });
    },

    async updateEdge(input) {
      await kgFetch(await creds(), {
        method: 'PATCH',
        path: `/edges/${input.edgeId}`,
        body: { properties: input.properties satisfies KgPropertyWrite[], ...writeProvenance(input.mutationContext) },
      });
    },

    async removeEdge(input) {
      return kgFetch<{ removed: boolean }>(await creds(), { method: 'DELETE', path: '/edges', body: edgeBody(input) });
    },

    async removeNode(input) {
      const result = await kgFetchOrNull<{ removed: boolean }>(await creds(), {
        method: 'DELETE',
        path: `/nodes/${input.nodeId}`,
        body: writeProvenance(input.mutationContext),
      });
      return { removed: result?.removed ?? false };
    },

    async attachResources(input) {
      await persistKgResources({ creds: await creds(), teamId: team, nodeId: input.nodeId, resources: input.resources });
    },

    async registerChangeWebhook(input) {
      if (install.credentialsId === undefined) return null;
      return registerKnowledgeWebhook({
        credentialsId: install.credentialsId,
        teamId: team,
        targetUrl: input.targetUrl,
        eventTypes: input.eventTypes,
      });
    },

    async removeChangeWebhook(input) {
      if (install.credentialsId === undefined) return;
      await deregisterKnowledgeWebhook({ credentialsId: install.credentialsId, teamId: team, externalId: input.externalId });
    },
  };
}

function edgeBody(input: { edgeTypeId: string; sourceNodeId: string; targetNodeId: string; mutationContext: MutationContext }) {
  return {
    edgeTypeId: input.edgeTypeId,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    ...writeProvenance(input.mutationContext),
  };
}

/**
 * The write's provenance, in the store's vocabulary. `changeSource` is stated
 * rather than defaulted: a movement-authored write reads as `pipeline` in the
 * change feed (D37f), and left to default the same write would read as `api`
 * the moment it arrived over HTTP. The mutation context travels verbatim:
 * `suppress_self` answers itself from one marker in it.
 */
function writeProvenance(mutationContext: MutationContext) {
  return {
    evidence: {
      type: mapEvidenceType(mutationContext.source.type),
      description: describeEvidence(mutationContext),
    },
    changeSource: ChangeSource.pipeline,
    mutationContext,
  };
}

/** The coarse classification the ontology's `writable_by` gate reasons about;
 *  the structured context carries the full provenance. */
function mapEvidenceType(sourceType: MutationSourceType): EvidenceType {
  switch (sourceType) {
    case 'structured_input':
      return EvidenceType.input_mapping;
    case 'extraction':
      return EvidenceType.extraction;
    case 'user_edit':
      return EvidenceType.user_edit;
    case 'api':
    case 'agent':
      return EvidenceType.user_edit; // closest fit; structured context has the real source
  }
}

function describeEvidence(ctx: MutationContext): string {
  const parts: string[] = [];
  if (ctx.source.translationGraphId) parts.push(`tg=${ctx.source.translationGraphId}`);
  if (ctx.source.translationGraphNodeId) parts.push(`node=${ctx.source.translationGraphNodeId}`);
  if (ctx.source.adapterType) parts.push(`adapter=${ctx.source.adapterType}`);
  if (ctx.source.pipelineInputId) parts.push(`input=${ctx.source.pipelineInputId}`);
  if (parts.length === 0) return `source=${ctx.source.type}`;
  return parts.join(' ');
}
