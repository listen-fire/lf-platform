// Ruling 5: the inbound address is one box every team shares, told apart by
// the plus-suffix mail is sent to (`Key`). A listen on it names its key, or
// the save refuses it by name; the door routes mail to the team whose listen
// names its key.

import type { ListenPlan, PlanHop } from 'engine-contracts';
import type { Expression } from 'movement-lang/expression/types';

import { inboxKeysOf, keylessInboxListen } from '../listen_keys';

const key = (value: string): Expression => ({ type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Key' }, right: { type: 'static', value } });
const subject = (value: string): Expression => ({ type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Subject' }, right: { type: 'static', value } });

function emailListen(where: Pick<PlanHop, 'taken' | 'checked'> = {}, adapter = 'email'): ListenPlan {
  return { movement: 'intake', connection: 'inbox', adapter, hops: [{ edge: 'Emails', from: '', to: 'Email', judged: 'arrival', ...where }] };
}

describe('the keys an email listen names', () => {
  it('reads `Key ==` wherever the WHERE puts it, lowercased as the door reads a plus-suffix', () => {
    expect(inboxKeysOf(emailListen({ checked: key('Deals') }))).toEqual(['deals']);
    expect(inboxKeysOf(emailListen({ taken: key('deals'), checked: subject('Intro') }))).toEqual(['deals']);
  });

  it('reads `Key IN [...]` and an OR of keys as each of them', () => {
    const inList: Expression = { type: 'compare', op: 'in', left: { type: 'property', propertyTypeId: 'Key' }, right: { type: 'list', elements: [{ type: 'static', value: 'a' }, { type: 'static', value: 'b' }] } };
    expect(inboxKeysOf(emailListen({ checked: inList }))).toEqual(['a', 'b']);
    expect(inboxKeysOf(emailListen({ checked: { type: 'logical', op: 'or', operands: [key('a'), key('b')] } }))).toEqual(['a', 'b']);
  });

  it('names none when some mail gets through whatever its key', () => {
    expect(inboxKeysOf(emailListen())).toEqual([]);
    expect(inboxKeysOf(emailListen({ checked: subject('Intro') }))).toEqual([]);
    expect(inboxKeysOf(emailListen({ checked: { type: 'logical', op: 'or', operands: [key('a'), subject('Intro')] } }))).toEqual([]);
  });

  it('reads the key by its field id too', () => {
    const byId: Expression = { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'email:key' }, right: { type: 'static', value: 'deals' } };
    expect(inboxKeysOf(emailListen({ checked: byId }), { Email: { Key: 'email:key' } })).toEqual(['deals']);
  });
});

describe('a listen on the shared inbox without a key is refused at save', () => {
  it('refuses one that names no key, saying how to name one', () => {
    expect(keylessInboxListen(emailListen({ checked: subject('Intro') }))).toMatch(/fires intake hears Emails on the inbox every team shares without naming its key.*e\.Key == "deals"/);
  });

  it('refuses one that names only the box itself (`Key == ""`), whose mail is every team’s', () => {
    expect(keylessInboxListen(emailListen({ checked: key('') }))).not.toBeNull();
  });

  it('refuses it under whichever name the email module is constructed by', () => {
    expect(keylessInboxListen(emailListen({}, 'mailgun'))).not.toBeNull();
  });

  it('accepts one that names its key, and leaves every other module alone', () => {
    expect(keylessInboxListen(emailListen({ checked: key('deals') }))).toBeNull();
    expect(keylessInboxListen({ ...emailListen(), adapter: 'gmail', hops: [{ edge: 'Messages', from: '', to: 'Message', judged: 'arrival' }] })).toBeNull();
  });
});
