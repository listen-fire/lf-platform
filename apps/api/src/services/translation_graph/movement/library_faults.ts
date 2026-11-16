// How a fault inside a library is worded once it must not carry the library's
// lines. A leaf module: the places that store a diagnostic and the places that
// check who may read a library both need it, and neither imports the other.

// How the checker reports a fault inside an imported file: on the importer's
// import line, in the library's name and with its own line number. A fault
// two levels down carries one such prefix per level, outermost first.
const IN_LIBRARY = /^"([^"]+)" line \d+: /;

/** The libraries a diagnostic's message passes through, outermost first. */
export function librariesInMessage(message: string): string[] {
  const chain: string[] = [];
  for (let rest = message; ; ) {
    const match = IN_LIBRARY.exec(rest);
    if (match === null || match[1] === undefined) return chain;
    chain.push(match[1]);
    rest = rest.slice(match[0].length);
  }
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
export function withoutLibraryFaults<D extends { message: string }>(diagnostics: readonly D[]): D[] {
  return diagnostics.map((diagnostic) => {
    const [library] = librariesInMessage(diagnostic.message);
    return library === undefined ? diagnostic : { ...diagnostic, message: libraryFaultRecord(library) };
  });
}
