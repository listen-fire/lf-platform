// Release pins named by how they stand to the installed language, so a test
// that means "the line this release reads", "an older line" or "a newer line"
// keeps meaning it when the release moves. Under 0.x a line is a minor; from
// 1.0, a major (movement-lang `compatibilityKey`).

import { LANGUAGE_VERSION } from 'movement-lang';

const [major = 0, minor = 0] = LANGUAGE_VERSION.split('.').map(Number);

function lineAt(step: number): string {
  return major === 0 ? `0.${minor + step}.0` : `${major + step}.0.0`;
}

/** The first release of the installed line: read as written. */
export const SAME_LINE = lineAt(0);
/** The line before the installed one: refused, to be upgraded. */
export const OLDER_LINE = lineAt(-1);
/** The line after the installed one: refused, never read. */
export const NEWER_LINE = lineAt(1);
