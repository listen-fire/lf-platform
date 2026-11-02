// A tap on a button an automation wired to a callback before 0.13. Callbacks
// were retired with listen-fire 0.13 (ruling 7): the id the button carries
// names nothing any more, and the run that sent it was failed at the upgrade
// (ruling 8). The tapper is still told so, in place, rather than left with a
// spinner or silence: each chat door answers the tap with this text.

/** Every callback id carried this namespace prefix, so a door told one apart
 *  by one comparison and never parsed it. */
const CALLBACK_ID_PREFIX = 'cb_';

export function isRetiredCallbackId(value: string | undefined): boolean {
  return value !== undefined && value.startsWith(CALLBACK_ID_PREFIX);
}

export const RETIRED_CALLBACK_TEXT =
  'This button belongs to an automation written for an earlier release, and it no longer does anything. ' +
  'Ask its owner to upgrade the automation and run it again.';
