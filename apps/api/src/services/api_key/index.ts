import { randomBytes, createHash } from 'node:crypto';

import { ModelService } from '../utils';
import { currentContext } from '../context';
import { getCoreQb } from '../../lib/kysely';
import { installedScopes } from '../../products';

const API_KEY_PREFIX = 'lf_';

function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const bytes = randomBytes(32);
  const base64 = bytes.toString('base64url');
  const plaintext = `${API_KEY_PREFIX}${base64}`;
  const hash = createHash('sha256').update(plaintext).digest('hex');
  const prefix = `${API_KEY_PREFIX}${base64.slice(0, 8)}`;
  return { plaintext, hash, prefix };
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface CreateApiKeyInput {
  name: string;
  /**
   * Omit to grant every scope THIS installation has a surface for
   * (`installedScopes`). The old default was a fixed `['ingest', 'knowledge']`,
   * which named a scope no route gates on and withheld every other product's:
   * a key minted on a five-unit install was refused by valuations, asks and
   * automations, and `ingest` bought it nothing. Deriving the default from the
   * composition is what keeps "a key for this installation" meaning the same
   * thing on every shape, without ever naming a surface that is not mounted.
   */
  scopes?: string[];
  expiresAt?: Date;
  /**
   * The team the key is pinned to (`api_key.team_id`). Omit to let the scope
   * decide: a knowledge-scoped key is minted USER-ANCHORED (`team_id: null`) —
   * it spans every team the creating user is a member of, exactly like the MCP
   * OAuth mint. Pass `null` to force user-anchored; pass a team id to force a
   * pin. Anything ingest/valuations defaults to the creator's acting team.
   */
  teamId?: string | null;
}

interface ApiKeyValidationResult {
  valid: true;
  apiKey: {
    id: string;
    teamId: string | null;
    userId: string;
    scopes: string[];
  };
}

class ApiKey extends ModelService<'apiKey'> {
  protected readonly objectName = 'apiKey';

  async create({
    name,
    scopes = installedScopes(),
    expiresAt,
    teamId,
  }: CreateApiKeyInput) {
    const ctx = currentContext();
    const { plaintext, hash, prefix } = generateApiKey();

    // An automation- or knowledge-scoped key is the MCP/agent surface (the
    // Automation and Knowledge connectors): mint it user-anchored
    // (`team_id: null`) so it spans the creator's teams. Ingest/valuations
    // keys stay pinned to the acting team. An explicit `teamId` (including
    // `null`) overrides this default.
    const defaultsUserAnchored = scopes.includes('automation') || scopes.includes('knowledge');
    const resolvedTeamId =
      teamId !== undefined ? teamId : defaultsUserAnchored ? null : ctx.user.teamId;

    const apiKey = await this.model.create({
      data: {
        teamId: resolvedTeamId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes,
        expiresAt,
        createdBy: ctx.user.id,
      },
    });

    return {
      ...apiKey,
      key: plaintext,
    };
  }

  /**
   * Mint an api-key for an EXPLICIT owner, with NO auth-context dependency.
   * `create` reads the owning user + ability from `currentContext()`, which is
   * unavailable on the tokenless author-time connect-link route (mounted before
   * the auth gate). This path takes the owner directly (the connect token's
   * user/team) and inserts via Kysely — exactly how `persistCredential` writes
   * on that same route. Used by the intrinsic provisioner (connect-link AND the
   * in-app `addCredential`, both of which pass an explicit owner).
   */
  async createForOwner(input: {
    name: string;
    scopes: string[];
    teamId: string | null;
    createdBy: string;
    expiresAt?: Date;
  }): Promise<{ id: string; key: string }> {
    const { plaintext, hash, prefix } = generateApiKey();
    const [row] = await getCoreQb(['api_key'])
      .insertInto('api_key')
      .values({
        team_id: input.teamId,
        name: input.name,
        key_hash: hash,
        key_prefix: prefix,
        scopes: input.scopes,
        created_by: input.createdBy,
        ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
      } as never)
      .returning(['id'])
      .execute();
    return { id: (row as { id: string }).id, key: plaintext };
  }

  /** Revoke an api-key by id, with NO auth-context dependency (the context-based
   *  `revoke` team-scopes via `currentContext().user`). The error-path cleanup
   *  for `createForOwner` on the tokenless connect route. */
  async revokeById(id: string): Promise<void> {
    await getCoreQb(['api_key'])
      .updateTable('api_key')
      .set({ revoked_at: new Date() })
      .where('id', '=', id as never)
      .execute();
  }

  async validateKey(key: string): Promise<ApiKeyValidationResult | { valid: false }> {
    if (!key.startsWith(API_KEY_PREFIX)) {
      return { valid: false };
    }

    const hash = hashApiKey(key);
    const apiKey = await getCoreQb(['api_key'])
      .selectFrom('api_key')
      .where('key_hash', '=', hash)
      .select([
        'id',
        'team_id',
        'created_by',
        'scopes',
        'revoked_at',
        'expires_at',
      ])
      .executeTakeFirst();

    if (!apiKey) {
      return { valid: false };
    }

    if (apiKey.revoked_at) {
      return { valid: false };
    }

    if (apiKey.expires_at && apiKey.expires_at < new Date()) {
      return { valid: false };
    }

    // Update last_used_at asynchronously (fire and forget)
    getCoreQb(['api_key'])
      .updateTable('api_key')
      .set({ last_used_at: new Date() })
      .where('id', '=', apiKey.id)
      .execute()
      .catch(() => {
        // Ignore errors updating last_used_at
      });

    return {
      valid: true,
      apiKey: {
        id: apiKey.id,
        teamId: apiKey.team_id,
        userId: apiKey.created_by,
        scopes: apiKey.scopes,
      },
    };
  }

  async revoke(id: string) {
    const ctx = currentContext();

    return this.model.update({
      where: {
        id,
        teamId: ctx.user.teamId,
      },
      data: { revokedAt: new Date() },
    });
  }

  async listByTeam() {
    const ctx = currentContext();

    return this.model.findMany({
      where: {
        teamId: ctx.user.teamId,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }
}

const ApiKeyService = new ApiKey();

export { ApiKeyService, API_KEY_PREFIX };
