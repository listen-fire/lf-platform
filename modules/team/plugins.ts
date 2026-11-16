// The two declarations. Both are pure (the same claim names the same person
// until a membership changes, which the platform pushes) and carry a maximum
// age for the cache of a host that cannot be told (a cloud lf over HTTP).

import type { ExpressionType, PluginDeclaration } from '@listen-fire/engine-contracts';

import { TEAM_LEVELS } from './records';

/** The package a program imports (``import { `@lf-platform/team` as team } from plugins``). */
export const TEAM_PLUGINS_PACKAGE = '@lf-platform/team';

export const EMAIL_CLAIM = 'claim:email/address';
export const PHONE_CLAIM = 'claim:phone/e164';

export const TEAM_MAX_AGE_SECONDS = 300;

const claim: ExpressionType = {
  kind: 'union',
  of: [
    { kind: 'branded', of: { kind: 'string' }, brands: [EMAIL_CLAIM] },
    { kind: 'branded', of: { kind: 'string' }, brands: [PHONE_CLAIM] },
  ],
};

// Registered names are ASCII lower case with dashes; a program writes them
// camel case (`team.isMember`).
export const IS_MEMBER: PluginDeclaration = {
  priced: false,
  pure: true,
  maxAgeSeconds: TEAM_MAX_AGE_SECONDS,
  signature: {
    name: 'is-member',
    description: 'Whether the email address or phone number belongs to a member of the team.',
    params: [{ name: 'claim', type: claim, required: true }],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'boolean' } },
  },
};

export const USER_FOR: PluginDeclaration = {
  priced: false,
  pure: true,
  maxAgeSeconds: TEAM_MAX_AGE_SECONDS,
  signature: {
    name: 'user-for',
    description:
      'The team member the email address or phone number belongs to, or nothing for someone who is not a member: a record with Id, Email, Name and Level (read, write or admin).',
    params: [{ name: 'claim', type: claim, required: true }],
    dataDependency: 'none',
    additions: {},
    effects: {},
    // A record, or none for someone who is not a member: a program reads a
    // field off it with `?.` (`team.userFor(m.`User Email`)?.Level`).
    output: {
      kind: 'record',
      optional: true,
      fields: {
        Id: { type: { kind: 'string' } },
        Email: { type: { kind: 'branded', of: { kind: 'string' }, brands: [EMAIL_CLAIM] } },
        Name: { type: { kind: 'string' } },
        Level: { type: { kind: 'enum', values: [...TEAM_LEVELS] } },
      },
    },
  },
};
