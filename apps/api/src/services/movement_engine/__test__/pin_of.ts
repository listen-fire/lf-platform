// Tests written when a pin was an integer still loop over behaviour numbers
// 1 to 5; this is the pin each number stands for now: 1 to 4 are the legacy
// ids, and 5 is the installed language.
import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';

export const pinOf = (behaviourNumber: number): LanguageVersion =>
  behaviourNumber >= 5 ? LANGUAGE_VERSION : String(behaviourNumber);
