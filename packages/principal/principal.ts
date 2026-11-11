// The Principal contract — the whole of what a product knows about identity
// (D2, core plan §3). A product sees opaque ids and an access level; it never
// sees core's tables, services, or middleware.

/** A team member's level there: each holds everything the one below it does. */
type Access = 'read' | 'write' | 'admin';

interface Principal {
  /** Opaque tenant id — the only scoping key. */
  readonly teamId: string;
  /** Absent for machine principals (inbound webhooks, schedulers, workers). */
  readonly userId?: string;
  readonly access: Access;
  /** Opaque to core; '*' grants everything. */
  readonly scopes: readonly string[];
  /** null = the credential spans the subject's memberships rather than one team. */
  readonly pinnedTeamId: string | null;
  /** Audit / rate-limit handle. Never parsed. */
  readonly credentialId?: string;
}

interface TeamRef {
  teamId: string;
  name: string;
  access: Access;
  /** A person's own workspace (team-of-one) rather than a shared/org team.
   *  Team identity, not authorization: a picker names it differently, and the
   *  MCP surface already returns it. */
  isPersonal: boolean;
}

/**
 * Not express's Request: products mount the same provider under express, Next
 * route handlers, and MCP transports, so the request a provider authenticates
 * is only the two lookups every one of those can answer.
 */
interface PrincipalRequest {
  readonly method: string;
  readonly url: string;
  header(name: string): string | undefined;
  cookie(name: string): string | undefined;
}

type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; message: string; wwwAuthenticate?: string };

interface PrincipalProvider {
  authenticate(req: PrincipalRequest): Promise<PrincipalResult>;
  /** Team pickers, MCP listTeams. */
  listTeams(p: Principal): Promise<TeamRef[]>;
  /** Throws {@link TeamScopeError} when the request names a team the principal cannot act in. */
  resolveTeam(p: Principal, requested?: string): Promise<TeamRef>;
}

/** The team a caller asked for is not one this principal can act in — or the
 *  caller must name one and did not. Carries the accessible teams so an agent
 *  caller can recover without a separate listTeams round-trip. */
class TeamScopeError extends Error {
  readonly teams?: TeamRef[];

  constructor(message: string, teams?: TeamRef[]) {
    super(message);
    this.name = 'TeamScopeError';
    this.teams = teams;
  }
}

function isAccess(value: unknown): value is Access {
  return value === 'read' || value === 'write' || value === 'admin';
}

function rankOf(access: Access): number {
  switch (access) {
    case 'read':
      return 0;
    case 'write':
      return 1;
    case 'admin':
      return 2;
    default: {
      const unknown: never = access;
      throw new Error(`Unknown access level: ${String(unknown)}`);
    }
  }
}

/** Whether team access `held` is at least `needed`: an admin holds whatever a write member does. */
function meets(held: Access, needed: Access): boolean {
  return rankOf(held) >= rankOf(needed);
}

/** The lesser of two levels. */
function narrower(a: Access, b: Access): Access {
  return meets(a, b) ? b : a;
}

export {
  type Access,
  type Principal,
  type TeamRef,
  type PrincipalRequest,
  type PrincipalResult,
  type PrincipalProvider,
  TeamScopeError,
  isAccess,
  meets,
  narrower,
};
