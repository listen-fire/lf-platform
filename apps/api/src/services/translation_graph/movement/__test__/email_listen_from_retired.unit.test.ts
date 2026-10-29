// `from: "anyone"` on an email listen, as automations saved on a fork carry it.
//
// The fork opened an address from the program; here the team's public inbox
// claim does, and the migration that introduced claims made one for each such
// listen. Those automations are pinned to language version 1 or 2, their text
// is never rewritten for them, and the engine re-checks every run — so under
// those pins the key must not be an error, or every run would fail. It is a
// warning that says where the decision lives now. From version 3 it was never
// part of the language and stays an unknown key.

import type { LanguageVersion } from 'movement-lang';
import { checkProgram } from 'legacy-lang';
import { parseProgram } from 'legacy-lang';

import { staticCatalogFromManifests } from '../catalog';

const catalog = staticCatalogFromManifests({});

function listenDiagnosticsOf(source: string, languageVersion: LanguageVersion) {
  const options = { languageVersion };
  return checkProgram(parseProgram(source, options), catalog, options)
    .filter((d) => d.code === 'MOV_LISTEN_BAD_CONFIG')
    .map((d) => ({ severity: d.severity ?? 'error', message: d.message }));
}

const PROGRAM = (construct: string, config: string) => `import { ${construct} } from adapters

inbox = ${construct}()

function \`Log Intro\`(m: <inbox-[:Email]->>) {
  return m.Subject
}

listen to inbox { key: "nemo", ${config} } fire \`Log Intro\`
`;

describe('a fork’s `from` key on an email listen', () => {
  it.each(['1', '2'])('is a warning, not an error, under version %s', (version) => {
    const diagnostics = listenDiagnosticsOf(PROGRAM('email', 'from: "anyone"'), version);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toMatch(/public inbox/);
  });

  it('says a `from: "known"` is how every listen already behaves', () => {
    const diagnostics = listenDiagnosticsOf(PROGRAM('email', 'from: "known"'), '2');
    expect(diagnostics).toEqual([{ severity: 'warning', message: expect.stringMatching(/can be removed/) }]);
  });

  it('holds whichever name the email adapter is constructed by', () => {
    const diagnostics = listenDiagnosticsOf(PROGRAM('mailgun', 'from: "anyone"'), '1');
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning']);
  });

  it('still refuses a value the fork never accepted', () => {
    const diagnostics = listenDiagnosticsOf(PROGRAM('email', 'from: "everyone"'), '2');
    expect(diagnostics).toEqual([
      { severity: 'error', message: expect.stringContaining("do not accept a config key 'from'") },
    ]);
  });

  it.each(['3', '4'])('is an unknown key under version %s, which never had it', (version) => {
    const diagnostics = listenDiagnosticsOf(PROGRAM('email', 'from: "anyone"'), version);
    expect(diagnostics).toEqual([
      { severity: 'error', message: expect.stringContaining("do not accept a config key 'from'") },
    ]);
  });
});
