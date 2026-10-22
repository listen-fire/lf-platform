// How an agent names a language version when it calls a tool. The string is
// the pin as stored; the integer is the form from before pins were releases,
// accepted for one release (0.13) and dropped after it.

import { z } from 'zod';

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';

export const languageVersionInput = z.union([z.string(), z.number().int()]);

export const LANGUAGE_VERSION_INPUT_DESCRIPTION =
  "Check under this language version instead — send the string form, the `version` from listAutomations' `languageVersion` (for example \"0.12.0\", or \"4\" for a legacy automation). The old integer is accepted this release only: 5 means the installed language, 1 to 4 the legacy ids. Use it to see what an older automation would need to move to the current version.";

export type PinInput = { pin: LanguageVersion } | { error: string };

/** A string passes through as the pin (the rule refuses what it does not read);
 *  5 is the installed language; 1 to 4 are the legacy ids; any other integer
 *  is refused, naming the forms accepted. */
export function pinFromInput(input: string | number): PinInput {
  if (typeof input === 'string') return { pin: input };
  if (input === 5) return { pin: LANGUAGE_VERSION };
  if (Number.isInteger(input) && input >= 1 && input <= 4) return { pin: String(input) };
  return {
    error: `Invalid languageVersion ${input}: send the version as a string such as "${LANGUAGE_VERSION}", or one of the legacy ids "1" to "4" (the integers 1 to 5 are accepted this release only).`,
  };
}
