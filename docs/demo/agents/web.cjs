// The web every option may search, the same for all three: a fixed corpus of
// public documentation pages (web/*.md: Stripe's webhook, event and invoice
// pages, Attio's REST API pages), searched and fetched deterministically, so
// a recording does not depend on a live search engine. Each page describes
// what the stand-in systems here really do (the fake Stripe's events, the
// Attio stand-in's REST API), in the vendor's own terms.
//
//   web_search  { query }  up to five pages: title, URL and the paragraph
//                          that best matches the query
//   web_fetch   { url }    one page, whole
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'web');
const pages = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    const url = /^url: (.+)$/m.exec(text)[1].trim();
    const title = /^title: (.+)$/m.exec(text)[1].trim();
    const body = text.replace(/^url: .+\n/m, '').replace(/^title: .+\n/m, '').trim();
    return { url, title, body, paragraphs: body.split(/\n\s*\n/) };
  });

const words = (t) => String(t).toLowerCase().match(/[a-z0-9_.]+/g) ?? [];
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'and', 'or', 'for', 'on', 'is', 'how', 'what', 'with', 'api', 'docs']);
function score(text, terms) {
  const ws = words(text);
  return terms.reduce((s, t) => s + ws.filter((w) => w === t || w.startsWith(t)).length, 0);
}

function search(query) {
  const terms = words(query).filter((t) => !STOP.has(t));
  if (terms.length === 0) return 'No results.';
  const ranked = pages
    .map((p) => ({ p, s: score(p.title, terms) * 4 + score(p.url, terms) * 2 + score(p.body, terms) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.p.url.localeCompare(b.p.url))
    .slice(0, 5);
  if (ranked.length === 0) return 'No results.';
  return ranked
    .map(({ p }) => {
      const best = [...p.paragraphs].sort((a, b) => score(b, terms) - score(a, terms))[0];
      const snippet = best.replace(/\s+/g, ' ').slice(0, 300);
      return `${p.title}\n${p.url}\n${snippet}${best.length > 300 ? '…' : ''}`;
    })
    .join('\n\n');
}

function fetchPage(url) {
  const want = String(url).replace(/[#?].*$/, '').replace(/\/+$/, '');
  const page = pages.find((p) => p.url === want);
  if (!page) throw new Error(`could not fetch ${url}: 404 Not Found`);
  return `${page.title}\n${page.url}\n\n${page.body}`;
}

const webTools = [
  { name: 'web_search', description: 'Search the web. Answers up to five results, each with its title, URL and a snippet.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'web_fetch', description: 'Fetch a web page by its URL, as text.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];
/** The answer to a web tool call, or undefined when `name` is not one. */
function runWeb(name, input) {
  if (name === 'web_search') return search(input.query);
  if (name === 'web_fetch') return fetchPage(input.url);
  return undefined;
}

module.exports = { webTools, runWeb, search, fetchPage };
