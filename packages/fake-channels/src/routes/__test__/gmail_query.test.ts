import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateGmailQuery,
  GmailQueryError,
  parseGmailQuery,
  type QueryTarget,
} from '../gmail_query';

const NOW = Date.UTC(2026, 9, 5);

function target(
  overrides: Partial<{ subject: string; labels: string[]; filenames: string[]; ageDays: number }> = {},
): QueryTarget {
  const subject = overrides.subject ?? 'Fwd: Intro to Acme';
  return {
    headers: new Map([
      ['subject', subject],
      ['from', 'Jane Founder <jane@acme.com>'],
      ['to', 'me@us.com'],
    ]),
    labels: overrides.labels ?? ['INBOX', 'UNREAD'],
    filenames: overrides.filenames ?? [],
    freeText: `${subject}\nhello there`.toLowerCase(),
    internalDateMs: NOW - (overrides.ageDays ?? 1) * 86_400_000,
  };
}

function matches(query: string, t: QueryTarget = target()): boolean {
  return evaluateGmailQuery(parseGmailQuery(query), t, NOW);
}

test('the builder query subject:(Fwd OR Fw) -subject:Re matches a forward and not a reply', () => {
  const q = 'subject:(Fwd OR Fw) -subject:Re';
  assert.equal(matches(q), true);
  assert.equal(matches(q, target({ subject: 'Re: Fwd: Intro' })), false);
  assert.equal(matches(q, target({ subject: 'Lunch?' })), false);
});

test('terms are implicit AND, case-insensitive, and bare words search the body', () => {
  assert.equal(matches('HELLO acme'), true);
  assert.equal(matches('hello missing'), false);
  assert.equal(matches('SUBJECT:intro FROM:JANE@acme.com'), true);
});

test('quoted phrases match as a unit, also inside a field', () => {
  assert.equal(matches('"intro to acme"'), true);
  assert.equal(matches('"acme intro"'), false);
  assert.equal(matches('subject:"intro to"'), true);
});

test('OR and | work at top level, and OR binds tighter than the implicit AND', () => {
  assert.equal(matches('nomatch OR hello'), true);
  assert.equal(matches('nomatch | hello'), true);
  assert.equal(matches('hello nomatch OR acme'), true);
  assert.equal(matches('nomatch OR other'), false);
});

test('parentheses group, and negation applies to a whole group', () => {
  assert.equal(matches('(nomatch OR hello) acme'), true);
  assert.equal(matches('-(nomatch OR other)'), true);
  assert.equal(matches('-(hello OR other)'), false);
  assert.equal(matches('-from:jane'), false);
});

test('{a b} is an OR group', () => {
  assert.equal(matches('{nomatch hello}'), true);
  assert.equal(matches('subject:{nomatch intro}'), true);
  assert.equal(matches('{nomatch other}'), false);
});

test('label, in, is, has and filename operators', () => {
  assert.equal(matches('label:inbox'), true);
  assert.equal(matches('in:INBOX'), true);
  assert.equal(matches('is:unread'), true);
  assert.equal(matches('is:read'), false);
  assert.equal(matches('has:attachment'), false);
  assert.equal(matches('has:attachment filename:deck', target({ filenames: ['Pitch-Deck.pdf'] })), true);
  assert.equal(matches('-has:attachment'), true);
});

test('newer_than, older_than, after and before compare against the message date', () => {
  assert.equal(matches('newer_than:2d', target({ ageDays: 1 })), true);
  assert.equal(matches('newer_than:2d', target({ ageDays: 3 })), false);
  assert.equal(matches('older_than:2d', target({ ageDays: 3 })), true);
  assert.equal(matches('after:2026/10/01'), true);
  assert.equal(matches('before:2026/10/01'), false);
});

test('an empty query matches everything', () => {
  assert.equal(matches(''), true);
  assert.equal(matches('   '), true);
});

test('category: matches the inbox tab, with unlabelled mail in Primary', () => {
  const q = '-category:promotions -category:social';
  assert.equal(matches(q), true);
  assert.equal(matches(q, target({ labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })), false);
  assert.equal(matches(q, target({ labels: ['INBOX', 'CATEGORY_SOCIAL'] })), false);
  assert.equal(matches(q, target({ labels: ['INBOX', 'CATEGORY_UPDATES'] })), true);
  assert.equal(matches('category:primary'), true);
  assert.equal(matches('category:primary', target({ labels: ['INBOX', 'CATEGORY_PERSONAL'] })), true);
  assert.equal(matches('category:primary', target({ labels: ['INBOX', 'CATEGORY_FORUMS'] })), false);
  assert.equal(matches('CATEGORY:Forums', target({ labels: ['CATEGORY_FORUMS'] })), true);
});

test('what the parser cannot understand throws, naming the problem', () => {
  const refused: Array<[string, RegExp]> = [
    ['larger:5M', /unsupported operator "larger:"/],
    ['category:spam', /category:spam/],
    ['subject:(a OR b', /missing "\)"/],
    ['a OR', /"OR" with nothing after it/],
    ['OR a', /"OR" with nothing before it/],
    ['a)', /unmatched "\)"/],
    ['"open phrase', /unterminated quote/],
    ['subject:', /no value/],
    ['has:drive', /has:drive/],
    ['is:snoozed', /is:snoozed/],
    ['newer_than:soon', /newer_than:soon/],
    ['after:yesterday', /after:yesterday/],
  ];
  for (const [query, reason] of refused) {
    assert.throws(
      () => parseGmailQuery(query),
      (error) => error instanceof GmailQueryError && reason.test(error.message),
      query,
    );
  }
});
