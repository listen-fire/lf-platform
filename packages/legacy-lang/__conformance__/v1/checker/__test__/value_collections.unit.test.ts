// Value collections completed — dicts, the collection ops, and MEMBERS.
//
// A value collection is a list or a dict; positions keep the traversal-headed
// block. `{ k: v }` is the dict literal, `AT(d, k)` is the lookup, and the key
// world is text and nothing else. `MAP` / `FILTER` / `REDUCE` / `GROUPBY` /
// `KEYBY` take a FUNCTION, which is why they are read where `race` is rather
// than by the expression bridge. `MEMBERS(<T>)` is a closed type's values in
// the order they were declared.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: {
        Messages: { target: 'message', readable: true, sequenced: 'chronological' },
        Members: { target: 'person', readable: true },
      },
    },
    message: { properties: { Text: 'text', At: 'datetime' }, edges: {} },
    person: { properties: { Name: 'text', Age: 'number' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Stage: { kind: 'enum', options: ['Seed', 'Series A'] } },
      edges: {},
    },
  },
  collections: { Companies: { target: 'company' } },
  writableRoots: {
    companies: {
      fields: {
        Name: 'text',
        // Open (known values) — other values are legal, so there is no complete
        // membership to walk.
        Tier: { kind: 'enum', options: ['gold', 'silver'], open: {} },
        Stage: { kind: 'enum', options: ['Seed', 'Series A'] },
      },
      resultShape: {},
      edges: {},
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    slack: { constructionArgs: [], schema: chatSchema },
    attio: { constructionArgs: [], schema: crmSchema },
  },
});

const PRELUDE = `import { slack, attio } from adapters
type Thesis = <"Consumer" | "Infra" | "Health">
chat = slack()
crm = attio()
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(c: <chat-[:channel]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('the dict literal', () => {
  it('a brace-led value is a dict, and a lookup off it may come up empty', () => {
    // Bound, then read — a value the write field must discharge, exactly as
    // every other maybe-absent read is.
    expect(codes('  d = { one: "a", two: "b" }\n  write chat-[:note]-> { Body ?: AT(d, "one") }')).toEqual([]);
  });

  it('the lookup is possibly absent, so an undischarged write is refused', () => {
    const body = '  d = { one: "a" }\n  write chat-[:note]-> { Body: AT(d, "one") }';
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a non-text key is refused, naming the coercion to write', () => {
    const body = [
      '  d = { one: "a" }',
      '  n = 3',
      '  write chat-[:note]-> { Body ?: AT(d, n) }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_DICT_KEY_NOT_TEXT');
    expect(messages(body)).toContain('keyed by text');
  });

  it('a date key names DATE.FORMAT — the coercion that exists', () => {
    const body = [
      '  d = { one: "a" }',
      '  when = DATE("2026-01-01")',
      '  write chat-[:note]-> { Body ?: AT(d, when) }',
    ].join('\n');
    expect(messages(body)).toContain('DATE.FORMAT');
  });

  it('a literal whose values disagree is json, not a dict — nothing claims a shape for it', () => {
    // A json value is opaque, so folding it into text is the error that says
    // this is not a dict of text.
    expect(codes('  d = { a: "x", b: 3 }\n  t = CONCAT(d, "!")')).toContain('MOV_JSON_OPAQUE');
  });

  it('the retired inline block still refuses by name — the `.binding` tells them apart', () => {
    expect(codes('  x = { a = 1 }.a')).toContain('MOV_INLINE_BLOCK_RETIRED');
  });
});

describe('MAP / FILTER over a value collection', () => {
  const NAMES = '  names = COLLECT(c-[m:Messages]->.`Text`)\n';

  it("MAP's function takes one member, untyped — the collection says what it is", () => {
    expect(codes(`${NAMES}  loud = MAP(names, (t) => { return UPPER(t) })`)).toEqual([]);
  });

  it('the member keeps its type inside the function', () => {
    // A text member added up is an arithmetic error — proof the element type
    // reached the parameter.
    expect(
      codes(`${NAMES}  bad = MAP(names, (t) => { return t + 1 })`),
    ).toContain('MOV_ARITH_NON_NUMERIC');
  });

  it('an annotation on the parameter still wins where one is written', () => {
    expect(codes(`${NAMES}  n = MAP(names, (t: <text>) => { return UPPER(t) })`)).toEqual([]);
  });

  it('a function with the wrong number of parameters is refused', () => {
    const body = `${NAMES}  x = MAP(names, (a, b) => { return a })`;
    expect(codes(body)).toContain('MOV_COLLECTION_OP_ARITY');
    expect(messages(body)).toContain('one member at a time');
  });

  it('a function that hands nothing back is refused', () => {
    expect(codes(`${NAMES}  x = MAP(names, (t) => { y = t })`)).toContain(
      'MOV_COLLECTION_OP_RETURNS_NOTHING',
    );
  });

  it('a function that waits is refused, naming where waiting belongs', () => {
    const body = `${NAMES}  x = MAP(names, (t) => { await sleep(1d)\n    return t })`;
    expect(codes(body)).toContain('MOV_COLLECTION_OP_SUSPENDS');
    expect(messages(body)).toContain('parallel');
  });

  it('reading POSITIONS is refused, and the message names the traversal-headed block', () => {
    const body = '  x = MAP(c, (p) => { return p })';
    expect(codes(body)).toContain('MOV_COLLECTION_OP_NOT_A_COLLECTION');
    expect(messages(body)).toContain('traversal-headed block');
  });

  it('MAP preserves the input ordering: an unordered list stays unordered', () => {
    // Members are unordered, so a JOIN of what MAP made of them is the same
    // refusal a JOIN of the members would be.
    expect(
      codes([
        '  people = COLLECT(c-[p:Members]->.`Name`)',
        '  loud = MAP(people, (n) => { return "${n}!" })',
        '  t = JOIN(loud, ", ")',
      ].join('\n')),
    ).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('…and an ordered one stays ordered', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  loud = MAP(lines, (t) => { return "${t}!" })',
        '  joined = JOIN(loud, "\\n")',
      ].join('\n')),
    ).toEqual([]);
  });

  it('FILTER hands back the members it was given', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  kept = FILTER(lines, (t) => { return t != "" })',
        '  joined = JOIN(kept, "\\n")',
      ].join('\n')),
    ).toEqual([]);
  });
});

describe('REDUCE is order-sensitive', () => {
  it('over an unordered collection it is refused, like every other order-sensitive fold', () => {
    const body = [
      '  ages = COLLECT(c-[p:Members]->.`Age`)',
      '  total = REDUCE(ages, 0, (carried, n) => { return carried + n })',
    ].join('\n');
    expect(codes(body)).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('over an ordered one it is clean, and its value is what the function returns', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  all = REDUCE(lines, "", (carried, t) => { return CONCAT(carried, t) })',
        '  write chat-[:note]-> { Body: all }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('its function takes two things, and one is refused', () => {
    const body = [
      '  lines = COLLECT(c-[m:Messages]->.`Text`)',
      '  all = REDUCE(lines, "", (t) => { return t })',
    ].join('\n');
    expect(codes(body)).toContain('MOV_COLLECTION_OP_ARITY');
    expect(messages(body)).toContain('carried so far');
  });
});

describe('GROUPBY and KEYBY build dicts', () => {
  const LINES = '  lines = COLLECT(c-[m:Messages]->.`Text`)\n';

  it('a lookup into a dict may miss, so an undischarged write is refused', () => {
    // KEYBY's members are text, so this reads a text field directly — the
    // absence is the only thing left to report, which is what proves a
    // lookup can come up empty. (A JOIN would discharge it: joining nothing
    // is the empty string, the fold's own zero.)
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = KEYBY(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body: AT(by, "A") }',
      ].join('\n')),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a group discharged with COALESCE joins cleanly — the group keeps the source order', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = GROUPBY(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body ?: JOIN(AT(by, "A"), ", ") }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('a key that is not text is refused at the key function', () => {
    const body = [
      '  ages = COLLECT(c-[p:Members]->.`Age`)',
      '  by = GROUPBY(ages, (n) => { return n })',
    ].join('\n');
    expect(codes(body)).toContain('MOV_DICT_KEY_NOT_TEXT');
  });

  it('KEYBY hands back the member itself, not a list of them', () => {
    // The member is text, so joining the looked-up value is a type error —
    // proof KEYBY did not wrap it in a list.
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = KEYBY(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body ?: AT(by, "A") }',
      ].join('\n')),
    ).toEqual([]);
  });
});

describe('MEMBERS — a closed type, in declaration order', () => {
  it('a declared refinement lists its values, and the list is ordered', () => {
    expect(
      codes('  all = MEMBERS(<Thesis>)\n  t = JOIN(all, ", ")'),
    ).toEqual([]);
  });

  it('the members are the type, so they key a dict of it', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = GROUPBY(lines, (t) => { return "${t}!" })',
        '  all = MEMBERS(<Thesis>)',
        '  lines2 = MAP(all, (th) => { return JOIN(COALESCE(AT(by, th), []), ", ") })',
      ].join('\n')),
    ).toEqual([]);
  });

  it('written inside a collection op it is refused, naming the bind-first fix', () => {
    // A collection op and MEMBERS are read as their own statement (one takes a
    // function, the other a type — neither is an expression), so nesting one
    // gets a pointed refusal rather than a stray-character parse error.
    expect(() =>
      parseProgram(`${PRELUDE}\nmovement m(c: <chat-[:channel]->>) {\n  x = MAP(MEMBERS(<Thesis>), (t) => { return t })\n}`),
    ).toThrow(/bind it first/);
  });

  it('a borrowed CLOSED option set works the same way', () => {
    expect(codes('  all = MEMBERS(<crm-[:companies]->.`Stage`>)\n  t = JOIN(all, ", ")')).toEqual([]);
  });

  it('an OPEN known-values field is refused — its membership is not closed', () => {
    const body = '  all = MEMBERS(<crm-[:companies]->.`Tier`>)';
    expect(codes(body)).toContain('MOV_MEMBERS_NOT_CLOSED');
    expect(messages(body)).toContain('other values are legal');
  });

  it('a primitive is refused — there is nothing to list', () => {
    expect(codes('  all = MEMBERS(<text>)')).toContain('MOV_MEMBERS_NOT_CLOSED');
  });

  it('a name that is no type reports the ordinary unknown-type error', () => {
    expect(codes('  all = MEMBERS(<Nope>)')).toContain('MOV_UNKNOWN_TYPE_NAME');
  });
});

describe('a block head rooted at a value', () => {
  // The handbook's chunked rehearsal: one extraction per piece, gathered by a
  // block over the list of results. `MAP` hands each answer back in the
  // currency it arrived in, so the list holds extraction ROOTS — something the
  // value plane has no word for, which is exactly why it stays silent and runs.
  const CHUNKED = [
    '  pieces = CHUNKS(COALESCE(c.`Name`, ""), { size: 40 })',
    '  found = MAP(pieces, (p) => {',
    '    return extract from [p] {',
    '      node company: "each company named" {',
    '        name: "the company\'s name"',
    '      }',
    '    }',
    '  })',
  ].join('\n');

  it('a list of extraction results walks', () => {
    const body = [
      CHUNKED,
      '  found-[x:company]-> {',
      '    write chat-[:note]-> { Body ?: x.name }',
      '  }',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('one result held on the value plane walks too', () => {
    const body = [
      CHUNKED,
      '  one = AT(found, 0)',
      '  one-[x:company]-> {',
      '    write chat-[:note]-> { Body ?: x.name }',
      '  }',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('a list whose type IS known is refused — no value is a position', () => {
    const body = [
      '  names = COLLECT(c-[m:Messages]->.`Text`)',
      '  names-[x:company]-> {',
      '    write chat-[:note]-> { Body: "x" }',
      '  }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
    expect(messages(body)).toContain('list of text');
    expect(messages(body)).toContain('hop walks from a POSITION');
  });

  it('a plain text binding is refused the same way', () => {
    const body = [
      '  label = "hello"',
      '  label-[x:company]-> {',
      '    write chat-[:note]-> { Body: "x" }',
      '  }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
  });
});

describe('a parameter with no type, where nothing supplies one', () => {
  it('a bare closure parameter is refused', () => {
    const body = '  f = (x) => { return x }';
    expect(codes(body)).toContain('MOV_PARAM_NEEDS_TYPE');
  });

  it('a movement parameter is refused too — its type is the promise to callers', () => {
    const source = `${PRELUDE}\nmovement other(x) {\n  y = x\n}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain('MOV_PARAM_NEEDS_TYPE');
  });
});

describe('a list literal of records', () => {
  // `both = [one, two]` is a list of records — one type universe, so the list
  // holds records the way any list holds its members, and a head off it walks
  // each member in list order.
  const TWO = [
    '  one = node { name: "Acme", founder: node { name: "Jane Doe" } }',
    '  two = node { name: "Zenith", founder: node { name: "Ada Byron" } }',
    '  both = [one, two]',
  ].join('\n');

  it('two records in a list is clean', () => {
    expect(codes(TWO)).toEqual([]);
  });

  it('a block head off the list walks it', () => {
    expect(
      codes([
        TWO,
        '  both-[f:founder]-> {',
        '    write chat-[:note]-> { Body ?: f.name }',
        '  }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('a record and a value together are refused — a list holds one kind of thing', () => {
    const body = [
      '  one = node { name: "Acme" }',
      '  label = "hello"',
      '  both = [one, label]',
    ].join('\n');
    expect(codes(body)).toContain('MOV_LIST_MIXED');
    expect(messages(body)).toContain('one kind of thing');
    expect(messages(body)).toContain('is text');
  });

  it('a literal member is refused the same way', () => {
    expect(codes('  one = node { name: "Acme" }\n  both = [one, 3]')).toContain('MOV_LIST_MIXED');
  });

  it('a nested list is refused — a record and a list of them are not one kind', () => {
    const body = [
      '  one = node { name: "Acme" }',
      '  two = node { name: "Zenith" }',
      '  both = [one, [two]]',
    ].join('\n');
    expect(codes(body)).toContain('MOV_LIST_MIXED');
    expect(messages(body)).toContain('list of');
  });

  it('a computed member is judged by its TYPE, like every other member', () => {
    // The rule is one rule, read off the types: a text read out of a list of
    // text is text wherever it was written, so mixing it with a record is the
    // same mistake as writing the text inline.
    expect(
      codes([
        '  one = node { name: "Acme" }',
        '  names = COLLECT(c-[m:Messages]->.`Text`)',
        '  both = [one, AT(names, 0)]',
      ].join('\n')),
    ).toContain('MOV_LIST_MIXED');
  });

  it('a member nobody can type stays silent — the honesty rule', () => {
    // `KG_VALUE` answers a value nothing here describes. An untyped member says
    // nothing about the list, so the list says nothing either, and it is the
    // head or the read that names what it turned out to be.
    expect(
      codes([
        '  one = node { name: "Acme" }',
        '  both = [one, KG_VALUE("x")]',
      ].join('\n')),
    ).not.toContain('MOV_LIST_MIXED');
  });

  it('interpolating a record is refused where it is written, naming the record', () => {
    // A record has no one spelling as text and there is no implicit one — the
    // run refused this already; the type says so at the '=' instead.
    const body = '  one = node { name: "Acme" }\n  t = "${one}"';
    expect(codes(body)).toContain('MOV_RECORD_NOT_A_VALUE');
    expect(messages(body)).toContain('a record, not a value');
  });
});

describe('a list of records is an ordinary collection', () => {
  it('a collection op reads it — a record is a value, so a list of them is a list', () => {
    const body = [
      '  one = node { name: "Acme" }',
      '  two = node { name: "Zenith" }',
      '  both = [one, two]',
      '  x = MAP(both, (r) => { return r })',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('ONE record is still not a collection — the message names the block', () => {
    const body = '  one = node { name: "Acme" }\n  x = MAP(one, (r) => { return r })';
    expect(codes(body)).toContain('MOV_COLLECTION_OP_NOT_A_COLLECTION');
    expect(messages(body)).toContain('traversal-headed block');
  });

  it('members that agree on a type carry it, so the walk off the list is checked', () => {
    const body = [
      '  c-[msg:Messages]-> {',
      '    a = msg',
      '    b = msg',
      '    both = [a, b]',
      '    both-[n:Nope]-> {',
      '      write chat-[:note]-> { Body: "x" }',
      '    }',
      '  }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });
});

describe('a record is a value, so the collection ops carry records', () => {
  // One type universe: what a collection op hands back is what its function
  // returned, and a record is one of the things a function can return. The
  // proofs are what the checker says about a LATER read — a bad edge off a
  // member names the position, so the element type is visible from outside.

  it('MAP returning the member is a list of that record', () => {
    const body = [
      '  rows = MAP(c-[m:Messages]->, (t) => { return t })',
      '  rows-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('a hop is a collection — MAP over one needs no block first', () => {
    expect(codes('  rows = MAP(c-[m:Messages]->, (t) => { return t.`Text` })')).toEqual([]);
  });

  it('MAP returning a map literal is a list of maps, and the key keeps its type', () => {
    // `a` holds a number, so writing it into a text field is the number-into-
    // text mistake and nothing else — which is only sayable if the map's value
    // type survived the MAP.
    const body = [
      '  rows = MAP(c-[m:Messages]->, (t) => { return { a: 1 } })',
      '  first = AT(rows, 0)',
      '  write chat-[:note]-> { Body ?: AT(first, "a") }',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('MAP returning a map whose key holds a record is a list of those maps', () => {
    const body = [
      '  rows = MAP(c-[m:Messages]->, (t) => { return { a: t } })',
      '  first = AT(rows, 0)',
      '  write chat-[:note]-> { Body ?: AT(first, "a") }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_WRITE_FIELD_TYPE');
    expect(messages(body)).toContain('a record, not a value');
  });

  it('FILTER over records hands the records back', () => {
    const body = [
      '  rows = FILTER(c-[m:Messages]->, (t) => { return t.`Text` == "hi" })',
      '  rows-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('GROUPBY over records files lists of records under each key', () => {
    const body = [
      '  groups = GROUPBY(c-[m:Messages]->, (t) => { return t.`Text` })',
      '  one = AT(groups, "hi")',
      '  one-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('KEYBY over records files one record under each key', () => {
    const body = [
      '  byText = KEYBY(c-[m:Messages]->, (t) => { return t.`Text` })',
      '  one = AT(byText, "hi")',
      '  one-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('REDUCE hands back whatever the reducer returns', () => {
    expect(
      codes([
        '  total = REDUCE(c-[m:Messages]->, 0, (acc, t) => { return acc + 1 })',
        '  write chat-[:note]-> { Body ?: "${total}" }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('a head off one member of the list walks that record', () => {
    const body = [
      '  rows = MAP(c-[m:Messages]->, (t) => { return t })',
      '  first = AT(rows, 0)',
      '  first-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('interpolating a member inside the function is refused, naming the record', () => {
    const body = '  rows = MAP(c-[m:Messages]->, (t) => { return "${t}" })';
    expect(codes(body)).toContain('MOV_RECORD_NOT_A_VALUE');
  });

  it('writing a member into a field is refused, naming the record', () => {
    const body = [
      '  c-[msg:Messages]-> {',
      '    write chat-[:note]-> { Body: msg }',
      '  }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_WRITE_FIELD_TYPE');
    expect(messages(body)).toContain('a record, not a value');
  });

  it('a hop off a name bound to text is still refused where it is written', () => {
    const body = [
      '  names = MAP(c-[m:Messages]->, (t) => { return t.`Text` })',
      '  first = AT(names, 0)',
      '  first-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
  });
});
