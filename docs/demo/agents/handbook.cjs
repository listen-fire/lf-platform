// The handbook an authoring agent has under lf: listen-fire's own
// @listen-fire/handbook (the front page, the hand-written chapters, the
// language search), plus one `system:<module>` chapter per module this
// project installed, from that module's own manifest (its handbookSection),
// the way a host assembles them. Loaded from a listen-fire checkout's
// sources (LF_SRC), with the tsx its module kit uses.
const path = require('path');
const { createRequire } = require('module');

function loadHandbook(lfSrc, modules) {
  const fromKit = createRequire(path.join(lfSrc, 'packages/module-kit/package.json'));
  fromKit('tsx/cjs');
  const hb = require(path.join(lfSrc, 'packages/handbook/index.ts'));
  const chapters = { ...hb.CORE_CHAPTERS };
  for (const [name, file, exported] of modules) {
    const manifest = require(path.join(lfSrc, 'modules', name, file))[exported];
    const section = manifest.handbookSection;
    if (section) chapters[`system:${name}`] = { id: `system:${name}`, title: section.title, content: section.content };
  }
  const handbook = { intentIndex: hb.INTENT_INDEX, chapters };
  return {
    frontPage: () => hb.renderFrontPage(),
    index: () => hb.renderIndex(handbook),
    // A route is a chapter, `chapter#section`, or `front#<anchor>` (the front
    // page's own sections, which diagnostics point at).
    read: (route) => {
      const [id, section] = String(route).split('#');
      if (id === 'front') {
        if (!section) return hb.renderFrontPage();
        const r = hb.frontSection(section);
        return r.ok ? r.content : r.error;
      }
      const r = hb.readChapter(chapters, id, section || undefined);
      return r.ok ? r.content : r.error;
    },
    search: (query, kind) => JSON.stringify(hb.searchLanguage({ query, ...(kind ? { kind } : {}) }, chapters), null, 1),
  };
}

// The modules a comparison project installs: the CRM's (by scenario,
// CRM_KIND: @lf/mcp, or Attio's native @lf/attio), and the same three others.
const PROJECT_MODULES = [
  ['webhook', 'manifest.ts', 'WEBHOOK_MANIFEST'],
  process.env.CRM_KIND === 'rest' ? ['attio', 'manifest.ts', 'ATTIO_MANIFEST'] : ['mcp', 'manifest.ts', 'MCP_MANIFEST'],
  ['gmail', 'manifest.ts', 'GMAIL_MANIFEST'],
  ['slack', 'manifest.ts', 'SLACK_MANIFEST'],
];

module.exports = { loadHandbook, PROJECT_MODULES };
