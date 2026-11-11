// Who may start a run, as the door judges it from what it decided of who acted
// (fire_statement.ts): anyone needs no actor; a person, team or domain rule
// needs one the source system vouched for, except a claimed email address,
// until the email rework; a schedule is not judged, and a rule cannot be applied
// where the module says nothing of who acted or keeps its own Actor; who acted
// unknown is undecided.

import { normalisedActor } from 'engine-contracts';

import type { Grantee } from '../../access/statement';
import type { ActorDecision, PlatformActor } from '../actors';

jest.mock('../../../lib/kysely', () => ({ getAutomationsQb: jest.fn(), getCoreQb: jest.fn() }));

import { actorSourceOf, fireVerdict, type ActorSource } from '../fire_statement';

const ADA = '0a0a0a0a-0000-4000-8000-00000000ada0';
const FIRES = { kind: 'fires' };

/** Who acted, as the platform wrote it: proven unless said otherwise. */
function written(actor: Partial<PlatformActor> & { Email?: string }, addressMatch?: { user: string; vouched: boolean }): ActorDecision {
  const email = actor.Email;
  const domain = email === undefined ? undefined : email.slice(email.lastIndexOf('@') + 1);
  return {
    kind: 'written',
    actor: { Id: 'U1', Proven: true, Member: false, ...(email !== undefined ? { Email: email, Domain: domain } : {}), ...actor },
    ...(addressMatch !== undefined ? { addressMatch } : {}),
  };
}

const verdict = (fire: Grantee[], decided: ActorDecision, source: ActorSource = 'reported') => fireVerdict({ fire, decided, source });

describe('a domain rule', () => {
  const xcom: Grantee[] = [{ kind: 'domain', domain: 'x.com' }];

  it('passes a@x.com', () => {
    expect(verdict(xcom, written({ Email: 'a@x.com' }))).toEqual(FIRES);
  });

  it('refuses a@x.com.evil.com, whose domain is the part after its last @', () => {
    expect(verdict(xcom, written({ Email: 'a@x.com.evil.com' }))).toEqual({ kind: 'refused', reason: 'who acted is not among who may fire this automation' });
  });

  it('refuses a@x.com.evil.com as the platform normalises who acted, not as a test does', () => {
    const actor = normalisedActor({ identifier: 'U1', scheme: 'email', email: ' A@X.com.Evil.com ', proven: true });
    if (actor === null) throw new Error('test: the identity names someone');
    expect(actor.Domain).toBe('x.com.evil.com');
    expect(verdict(xcom, { kind: 'written', actor: { ...actor, Member: false } })).toMatchObject({ kind: 'refused' });
    const ada = normalisedActor({ identifier: 'U2', scheme: 'email', email: 'ada@X.com', proven: true });
    if (ada === null) throw new Error('test: the identity names someone');
    expect(verdict(xcom, { kind: 'written', actor: { ...ada, Member: false } })).toEqual(FIRES);
  });

  it('refuses x.com from a source that does not vouch for who acted', () => {
    expect(verdict(xcom, written({ Email: 'a@x.com', Proven: false }))).toMatchObject({ kind: 'refused' });
  });
});

describe('a team rule', () => {
  const team: Grantee[] = [{ kind: 'team' }];

  it('passes a member the source system vouched for', () => {
    expect(verdict(team, written({ Email: 'ada@x.com', Member: true, User: ADA }, { user: ADA, vouched: true }))).toEqual(FIRES);
  });

  it('refuses an unproven actor, though their address is a member`s', () => {
    expect(verdict(team, written({ Email: 'ada@x.com', Proven: false }, { user: ADA, vouched: false }))).toEqual({
      kind: 'refused',
      reason: 'the source system does not vouch for who acted, and who may fire this automation names people, a team or a domain',
    });
  });

  it('refuses a proven stranger', () => {
    expect(verdict(team, written({ Email: 'eve@evil.com' }))).toMatchObject({ kind: 'refused' });
  });

  it('refuses an arrival that names no one', () => {
    expect(verdict(team, { kind: 'nobody' })).toMatchObject({ kind: 'refused' });
  });

  it('cannot be applied where the module`s own Actor field kept the platform from looking, as where the module says nobody acted', () => {
    expect(verdict(team, { kind: 'module' })).toEqual(FIRES);
    expect(verdict(team, { kind: 'module' }, 'claimed')).toEqual(FIRES);
  });

  it('leaves it undecided when who acted could not be looked up', () => {
    expect(verdict(team, { kind: 'unknown' })).toEqual({ kind: 'undecided', reason: 'who acted could not be looked up, so who may fire this automation cannot be judged' });
  });
});

describe('a person rule', () => {
  it('passes the named user, vouched for', () => {
    expect(verdict([{ kind: 'user', userId: ADA }], written({ Email: 'ada@x.com', Member: true, User: ADA.toUpperCase() }, { user: ADA, vouched: true }))).toEqual(FIRES);
  });

  it('passes the named address, and refuses another', () => {
    const pat: Grantee[] = [{ kind: 'email', address: 'pat@x.com' }];
    expect(verdict(pat, written({ Email: 'pat@x.com' }))).toEqual(FIRES);
    expect(verdict(pat, written({ Email: 'pam@x.com' }))).toMatchObject({ kind: 'refused' });
  });

  it('passes the named phone, as its digits with the country code first', () => {
    const phone: Grantee[] = [{ kind: 'phone', digits: '447700900123' }];
    expect(verdict(phone, written({ Phone: '447700900123' }))).toEqual(FIRES);
    expect(verdict(phone, written({ Phone: '447700900123', Proven: false }))).toMatchObject({ kind: 'refused' });
  });
});

describe('email, until its rework: a claimed address satisfies a person, team or domain rule', () => {
  const claimed = (actor: Partial<PlatformActor> & { Email?: string }, addressMatch?: { user: string; vouched: boolean }) => written({ Proven: false, ...actor }, addressMatch);

  it('passes a team rule for a member`s address, though no one vouched for it', () => {
    expect(verdict([{ kind: 'team' }], claimed({ Email: 'ada@x.com' }, { user: ADA, vouched: false }), 'claimed')).toEqual(FIRES);
  });

  it('passes a user rule for that member`s address', () => {
    expect(verdict([{ kind: 'user', userId: ADA }], claimed({ Email: 'ada@x.com' }, { user: ADA, vouched: false }), 'claimed')).toEqual(FIRES);
  });

  it('passes a domain rule and an address rule on what the sender claims', () => {
    expect(verdict([{ kind: 'domain', domain: 'x.com' }], claimed({ Email: 'a@x.com' }), 'claimed')).toEqual(FIRES);
    expect(verdict([{ kind: 'email', address: 'a@x.com' }], claimed({ Email: 'a@x.com' }), 'claimed')).toEqual(FIRES);
  });

  it('still refuses a@x.com.evil.com under x.com, and a stranger under a team rule', () => {
    expect(verdict([{ kind: 'domain', domain: 'x.com' }], claimed({ Email: 'a@x.com.evil.com' }), 'claimed')).toMatchObject({ kind: 'refused' });
    expect(verdict([{ kind: 'team' }], claimed({ Email: 'eve@evil.com' }), 'claimed')).toMatchObject({ kind: 'refused' });
  });
});

describe('what needs no actor', () => {
  it('anyone, whoever acted, or nobody', () => {
    expect(verdict([{ kind: 'anyone' }], { kind: 'nobody' })).toEqual(FIRES);
    expect(verdict([{ kind: 'team' }, { kind: 'anyone' }], { kind: 'unknown' })).toEqual(FIRES);
  });

  it('a schedule or the platform`s own events, whatever the list says', () => {
    expect(verdict([{ kind: 'team' }], { kind: 'unneeded' }, 'no_one_acts')).toEqual(FIRES);
    expect(verdict([], { kind: 'unneeded' }, 'no_one_acts')).toEqual(FIRES);
  });

  it('a module that does not say who acted, where the rule cannot be applied', () => {
    expect(verdict([{ kind: 'team' }], { kind: 'unneeded' }, 'not_reported')).toEqual(FIRES);
  });
});

it('nothing stated admits nobody', () => {
  expect(verdict([], written({ Email: 'ada@x.com', Member: true, User: ADA }))).toEqual({ kind: 'refused', reason: 'nothing states who may fire this automation' });
});

describe('how a module says who acted', () => {
  it('nobody acts on a schedule or the platform`s own events', () => {
    expect(actorSourceOf('cron', [])).toBe('no_one_acts');
    expect(actorSourceOf('system', [])).toBe('no_one_acts');
  });

  it('email claims it, under its own name or an alias', () => {
    expect(actorSourceOf('email', ['getActorCandidates'])).toBe('claimed');
    expect(actorSourceOf('resend', ['getActorCandidates'])).toBe('claimed');
  });

  it('a module reports it by listing a method that says who acted, and one that lists none does not', () => {
    expect(actorSourceOf('slack', ['getActorCandidates'])).toBe('reported');
    expect(actorSourceOf('airtable', ['getFieldValue'])).toBe('not_reported');
  });

  it('a module nothing describes is judged as one that says who acted', () => {
    expect(actorSourceOf('nowhere', undefined)).toBe('reported');
  });
});
