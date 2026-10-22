// The language's spelling of built-ins and code in a diagnostic, as a legacy
// pin reads it: versions 1 to 4 write the canonical spelling as it is (CAPS
// words, `IS NULL`), and this copy's version 5 asks the language release, which
// spells only its own surface (`Text.upper`, `x != null`).

import type { LanguageVersion } from 'movement-lang/language_version';
import {
  spellCode as spellCodeNow,
  spellMessage as spellMessageNow,
} from 'movement-lang/parser/surface';
import { before } from '../version_conditionals';

/** `message` naming every built-in it quotes as `version` spells it. */
export function spellMessage(message: string, version: LanguageVersion): string {
  return before(version, 5) ? message : spellMessageNow(message);
}

/** `code`, written in the canonical spelling, as `version` spells it. */
export function spellCode(code: string, version: LanguageVersion): string {
  return before(version, 5) ? code : spellCodeNow(code);
}

/** A word of code in prose: bare up to version 4, quoted from 5. */
export function spellWord(word: string, version: LanguageVersion): string {
  return before(version, 5) ? word : `'${spellCodeNow(word)}'`;
}

/** The head of an `if` a diagnostic suggests, as `version` spells it. */
export function spellIf(condition: string, version: LanguageVersion): string {
  return before(version, 5) ? `if ${condition}` : `if (${spellCodeNow(condition)})`;
}
