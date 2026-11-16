// What the module reads of the platform: who, in the invoking team, a claim
// names. The platform answers from its own tables (a team member by their
// non service email, plus addressing as the platform's inbound treats it, or
// by their verified phone), so the module holds no query of its own.

/** The access level a member holds in the team. */
export const TEAM_LEVELS = ['read', 'write', 'admin'] as const;
export type TeamLevel = (typeof TEAM_LEVELS)[number];

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  level: TeamLevel;
}

/** Everything is scoped to the team the records were made for: a user whose
 *  default team is another one is a member only where a membership row says. */
export interface TeamRecords {
  /** `email` is already lower case. */
  memberByEmail(email: string): Promise<TeamMember | null>;
  /** `phone` is a `claim:phone/e164` value (a plus, then digits). */
  memberByPhone(phone: string): Promise<TeamMember | null>;
}
