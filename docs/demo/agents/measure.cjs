// node measure.cjs <js|lf> <file>   (or require: measure(kind, source))
// Maintenance and bug-risk measures of one artefact, computed from its text
// by the method below, the same for the JavaScript handler and the
// listen-fire program wherever the languages allow.
//
// 1. Lexing. A small lexer splits the source into code, string literals and
//    comments (JS: '…', "…", `…` with ${…} read as code, // and /* */
//    comments; lf: "…" with ${…} read as code, # comments; lf's backticks
//    quote names and stay code). Every count below reads the code only,
//    except the credential scan, which reads code and strings.
// 2. lines: lines that hold code (blank lines and comment-only lines left out;
//    every non-blank line of a multi-line string counts).
// 3. decisionPoints: if (else-if included), case, catch, for, while, ?: (a
//    `?` that is not `?.`, `??` or lf's `?:` write form), &&, ||, ??, and lf's
//    AND and OR inside a walk.
// 4. handRolled: which of five concerns the code implements itself, each
//    found by a pattern (the evidence is kept):
//    - dedup: JS kv.get / kv.set; lf `unique by` or a lookup of its own past writes
//    - retry: retry / backoff / attempt identifiers, setTimeout or sleep
//    - errorHandling: JS try / catch / throw / isError; lf fail(…)
//    - inputValidation: a test of the event's own values: a comparison with
//      null / undefined, typeof, or a test of the event's type
//    - schemaHandling: unpacking a system's answer by hand: JS
//      structuredContent, .content, JSON.parse (MCP), .body, .values (a REST
//      answer, an Attio record's typed values); lf Json.*, and Text.lower /
//      Text.trim on a value read from a system
// 5. ioSites: places the code reaches an outside system. JS: calls of
//    crm.callTool, crm.listTools, crm.request, email.send, slack.post, fetch. lf: write
//    statements and walks from a connection (`<connection>-[`). madeBy says
//    who makes those calls: the code itself (JS) or lf's modules (lf).
// 6. credentials: credential names the code references (lf's `import { … }
//    from credentials`; JS none exist to reference), and any literal or
//    identifier in code or strings matching token / secret / api key /
//    password / bearer / authorization, or a URL (http:// or https://).
const fs = require('fs');

function lex(kind, src) {
  let code = '';
  const strings = [];
  let i = 0;
  const n = src.length;
  const readString = (quote) => {
    // at src[i] === quote; returns after the closing quote. ${…} inside a
    // template (JS `) or an lf "…" is code.
    let s = '';
    i++;
    const interpolates = (kind === 'js' && quote === '`') || (kind === 'lf' && quote === '"');
    // A line of a multi-line string holds code as much as any other line: a
    // line that is all string text (no ${…}, no closing quote) still counts.
    let lineHolds = true;
    const newline = () => {
      code += lineHolds ? ' S\n' : '\n';
      lineHolds = false;
    };
    while (i < n && src[i] !== quote) {
      if (src[i] === '\\') {
        if (src[i + 1] === '\n') newline();
        else lineHolds = true;
        s += src[i] + (src[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (interpolates && src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        let depth = 1;
        let inner = '';
        while (i < n && depth > 0) {
          if (src[i] === '{') depth++;
          if (src[i] === '}') depth--;
          if (depth > 0) inner += src[i];
          i++;
        }
        const sub = lex(kind, inner);
        code += ` ${sub.code} `;
        strings.push(...sub.strings);
        s += '${…}';
        lineHolds = true;
        continue;
      }
      if (src[i] === '\n') newline();
      else if (src[i].trim() !== '') lineHolds = true;
      s += src[i];
      i++;
    }
    i++;
    strings.push(s);
    code += 'S';
  };
  while (i < n) {
    const c = src[i];
    if (kind === 'js' && c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (kind === 'js' && c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') code += '\n';
        i++;
      }
      i += 2;
    } else if (kind === 'lf' && c === '#') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '"' || (kind === 'js' && (c === "'" || c === '`'))) {
      readString(c);
    } else {
      code += c;
      i++;
    }
  }
  return { code, strings };
}

function count(re, text) {
  return (text.match(re) ?? []).length;
}

function measure(kind, source) {
  const { code, strings } = lex(kind, source);
  const lines = code.split('\n').filter((l) => l.trim() !== '').length;
  const ternary = kind === 'js' ? count(/\?(?![.?])/g, code.replace(/\?\?/g, '')) : count(/\?(?![:.?+])/g, code);
  const decision = {
    if: count(/\bif\b/g, code),
    case: count(/\bcase\b/g, code),
    catch: count(/\bcatch\b/g, code),
    loop: count(/\b(for|while)\b/g, code),
    ternary,
    and: count(/&&/g, code) + (kind === 'lf' ? count(/\bAND\b/g, code) : 0),
    or: count(/\|\|/g, code) + (kind === 'lf' ? count(/\bOR\b/g, code) : 0),
    nullish: kind === 'js' ? count(/\?\?/g, code) : 0,
  };
  const decisionPoints = Object.values(decision).reduce((a, b) => a + b, 0);

  const find = (re) => [...new Set(code.match(re) ?? [])];
  const connections = kind === 'lf' ? [...code.matchAll(/^\s*(\w+)\s*=\s*connect\b/gm)].map((m) => m[1]) : [];
  const fromSystem = kind === 'lf' ? new RegExp(`\\b(${connections.join('|') || '$^'})-\\[`, 'g') : null;
  const concerns = {
    dedup: kind === 'js' ? find(/\bkv\.(get|set)\b/g) : find(/\bunique by\b/g),
    retry: find(/\b\w*(retry|Retry|backoff|Backoff|attempt|Attempt)\w*\b|\bsetTimeout\b|\bsleep\b/g),
    errorHandling: kind === 'js' ? find(/\b(try|catch|throw)\b|\bisError\b/g) : find(/\bfail\(/g),
    inputValidation: [...find(/(===?|!==?)\s*(null|undefined)\b|\b(null|undefined)\s*(===?|!==?)/g), ...find(/\btypeof\b/g), ...find(/\.type\s*(!==?|===?)/g)],
    schemaHandling: kind === 'js' ? find(/\bstructuredContent\b|\.content\b|\bJSON\.parse\b|\.body\b|\.values\b/g) : find(/\bJson\.\w+|\bText\.(lower|trim)\(/g),
  };
  const handRolled = Object.fromEntries(Object.entries(concerns).map(([k, v]) => [k, { present: v.length > 0, evidence: v }]));

  const ioSites =
    kind === 'js'
      ? { count: count(/\b(crm\.callTool|crm\.listTools|crm\.request|email\.send|slack\.post|fetch)\s*\(/g, code), madeBy: 'the code' }
      : { count: count(/\bwrite\b/g, code) + count(fromSystem, code), madeBy: "lf's modules (the program declares the reads and writes)" };

  const credentialNames = kind === 'lf' ? [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s+credentials/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean)) : [];
  const sensitive = /\b\w*(token|secret|api[_-]?key|password|bearer|authorization)\w*\b/gi;
  const urls = /https?:\/\/[^\s"'`)]+/g;
  const credentials = {
    namesReferenced: credentialNames,
    sensitiveIdentifiers: [...new Set([...(code.match(sensitive) ?? []), ...strings.flatMap((s) => s.match(sensitive) ?? [])])],
    urls: [...new Set([...(code.match(urls) ?? []), ...strings.flatMap((s) => s.match(urls) ?? [])])],
  };
  credentials.held = credentials.sensitiveIdentifiers.length === 0 && credentials.urls.length === 0 ? (kind === 'lf' ? 'outside the code: in the connections it names' : 'outside the code: in the sandbox globals') : 'the code holds some itself';

  return { kind, lines, decisionPoints, decision, handRolled, handRolledCount: Object.values(handRolled).filter((v) => v.present).length, ioSites, credentials };
}

module.exports = { measure, lex };

if (require.main === module) {
  const [kind, file] = process.argv.slice(2);
  console.log(JSON.stringify(measure(kind, fs.readFileSync(file, 'utf8')), null, 1));
}
