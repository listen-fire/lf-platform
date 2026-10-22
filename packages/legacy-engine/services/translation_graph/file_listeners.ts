// A file's `listen` statements, read as its pin reads them. The installed
// language has the run host's own units from version 5 on: `listen to manual
// fire backfill` needs no construction unless the file binds the name itself.
// A legacy id has no units, so such a listen resolves to nothing, as it did
// when the language still served the ids ('4' and before).

import { RUN_HOST_UNITS, type LanguageVersion, type Program } from 'movement-lang';
import { isLegacyLanguageVersion } from 'legacy-lang';
import { collectFileListeners as collectInstalled, type FileListener } from 'movement-engine/public/inbound';

export function collectFileListeners(program: Program, options: { languageVersion: LanguageVersion }): FileListener[] {
  const listeners = collectInstalled(program, options);
  if (!isLegacyLanguageVersion(options.languageVersion)) return listeners;
  // The only listeners the installed language adds over a legacy id's are the
  // ones its units resolved: a unit's name that no construction in the file binds.
  const constructed = new Set(
    program.statements.flatMap((statement) =>
      statement.kind === 'assign' && statement.value.kind === 'construct' ? [statement.name] : [],
    ),
  );
  return listeners.filter(
    (listener) => !RUN_HOST_UNITS.includes(listener.instanceName) || constructed.has(listener.instanceName),
  );
}
