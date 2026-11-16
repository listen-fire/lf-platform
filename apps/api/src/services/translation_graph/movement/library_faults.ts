// How a fault inside a library is worded once it must not carry the library's
// lines. A leaf module: the places that store a diagnostic and the places that
// check who may read a library both need it, and neither imports the other.

// How the checker words a fault inside an imported file. This is the one place
// that knows the wording, and it is read only where text alone survives (a
// stored run's failure) and for the levels below the first library: a
// diagnostic object names the library it came from in its `file` field. A fault in a file that runs is on the
// importer's import line, in the library's name and with its own line number,
// one such prefix per level, outermost first. A file that does not parse has
// no line prefix: the message begins with the library's name and the parser's
// words and position.
const IN_LIBRARY = /^"([^"]+)" line \d+: /;
const DOES_NOT_PARSE = /^"([^"]+)" does not parse/;

/** The libraries a diagnostic's message passes through, outermost first. */
export function librariesInMessage(message: string): string[] {
  const chain: string[] = [];
  for (let rest = message; ; ) {
    const through = IN_LIBRARY.exec(rest);
    if (through !== null && through[1] !== undefined) {
      chain.push(through[1]);
      rest = rest.slice(through[0].length);
      continue;
    }
    const unparseable = DOES_NOT_PARSE.exec(rest);
    if (unparseable !== null && unparseable[1] !== undefined) chain.push(unparseable[1]);
    return chain;
  }
}

/** The libraries a diagnostic's fault passes through, outermost first. The
 *  first is the diagnostic's `file`; the message is read only for the levels
 *  below it, which no field names. */
export function librariesOf(diagnostic: { message: string; file?: string }): string[] {
  const viaText = librariesInMessage(diagnostic.message);
  return diagnostic.file === undefined ? viaText : [diagnostic.file, ...viaText.slice(1)];
}

/** A failed run's check line: its code and the importer's line, then the library's words. */
export const RUN_CHECK_LINE = /^(\s*\S+ \(line \d+\): )"([^"]+)"(?: line \d+: | does not parse).*$/;

/** The diagnostic worded as given, with no edit: a fix's text could be the library's source. */
export function withoutLibraryText<D extends { message: string }>(diagnostic: D, message: string): D {
  const next = { ...diagnostic, message };
  Reflect.deleteProperty(next, 'fix');
  return next;
}

/** What a record says of a fault in a library: that there is one, never what. */
export function libraryFaultRecord(library: string): string {
  return `The library "${library}" has a fault. Open the library to see it.`;
}

/**
 * A diagnostic as it is stored or reported to no one in particular. A record
 * is read by everyone who may read the file it is about, and cannot know who
 * will read it, so a fault the check found inside a library names the library
 * and nothing of its lines. The library's readers see the fault by checking it.
 */
export function withoutLibraryFaults<D extends { message: string; file?: string }>(diagnostics: readonly D[]): D[] {
  return diagnostics.map((diagnostic) => {
    const [library] = librariesOf(diagnostic);
    return library === undefined ? diagnostic : withoutLibraryText(diagnostic, libraryFaultRecord(library));
  });
}
