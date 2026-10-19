// Reading an ask's answer link back out of a string a platform handed us.
//
// The token is MINTED here (`records.ts`), so it is parsed
// here too — one neighbourhood owns both directions. Every platform door that
// carries an answer (Slack's block actions, Telegram's callback queries) reads
// the same two shapes through this module, so no platform's door imports
// another platform's route to borrow a parser.

import { ASK_TOKEN_PREFIX } from './types';

/** Pull `{ token, answer? }` out of a string that MAY carry an ask token — a
 *  full `<api>/api/asks/<token>[?answer=<v>]` URL, or a bare
 *  `<token>[?answer=<v>]`. The answer is optional here (unlike
 *  {@link parseAskAction}): Slack's tap-time elements (datepicker/timepicker/
 *  text input) wire the BARE link into `action_id` — they can't pre-wire a
 *  `value` they don't know until the tap — and the caller pairs the token with
 *  whatever value the platform captured at tap time. Returns null when the
 *  string carries no recognisable ask token at all. */
export function parseAskLink(value: string): { token: string; answer?: string } | null {
  let token: string | undefined;
  let answer: string | undefined;
  try {
    // A full URL — read the token off the path, the answer off the query.
    const url = new URL(value);
    const seg = url.pathname.split('/').filter(Boolean).pop();
    if (seg && seg.startsWith(ASK_TOKEN_PREFIX)) token = seg;
    const a = url.searchParams.get('answer');
    if (a !== null) answer = a;
  } catch {
    // Not a URL — try `<token>[?answer=<v>]`.
    const [path, query] = value.split('?');
    const seg = path.split('/').filter(Boolean).pop();
    if (seg && seg.startsWith(ASK_TOKEN_PREFIX)) token = seg;
    if (query) {
      const params = new URLSearchParams(query);
      const a = params.get('answer');
      if (a !== null) answer = a;
    }
  }
  if (token === undefined) return null;
  return answer === undefined ? { token } : { token, answer };
}

/** The complete answer an author pre-wired into a control (Slack's button
 *  `value`, Telegram's `callback_data`): token AND answer. Returns null when
 *  the string is not an answer link at all, OR carries a token with no
 *  `?answer=` — that's the tap-time shape, which only Slack has and which its
 *  route resolves separately. */
export function parseAskAction(value: string): { token: string; answer: string } | null {
  const parsed = parseAskLink(value);
  if (!parsed || parsed.answer === undefined) return null;
  return { token: parsed.token, answer: parsed.answer };
}
