// Which inbox keys an email listen names (ruling 5). The deployment's inbound
// address is one box shared by every team; the plus-suffix mail is sent to
// (`inbox+deals@…`, the landing's `Key`) is what tells one team's mail from
// another's. So a listen on it must name its key, and the door routes mail to
// the team whose listen names that key.

import type { ListenPlan } from 'engine-contracts';
import type { Expression } from 'movement-lang/expression/types';
import { EMAIL_ADAPTER_NAMES, EMAIL_KEY_FIELD, EMAILS_EDGE } from '@listen-fire/email/types';

/** Whether `plan` listens on the shared inbox's mail. */
export function listensOnSharedInbox(plan: ListenPlan): boolean {
  return EMAIL_ADAPTER_NAMES.includes(plan.adapter) && plan.hops.at(-1)?.edge === EMAILS_EDGE;
}

function isKeyField(expression: Expression, keyIds: ReadonlySet<string>): boolean {
  return (expression.type === 'property' || expression.type === 'edge_property') && keyIds.has(expression.propertyTypeId);
}

function staticKey(expression: Expression): string | null {
  return expression.type === 'static' && typeof expression.value === 'string' ? expression.value.toLowerCase() : null;
}

/** The keys `expression` requires, or null when it lets other mail through. */
function requiredKeys(expression: Expression, keyIds: ReadonlySet<string>): string[] | null {
  switch (expression.type) {
    case 'compare': {
      if (expression.op === 'eq') {
        const key = isKeyField(expression.left, keyIds) ? staticKey(expression.right) : isKeyField(expression.right, keyIds) ? staticKey(expression.left) : null;
        return key === null ? null : [key];
      }
      if (expression.op === 'in' && isKeyField(expression.left, keyIds) && expression.right.type === 'list') {
        // A spread's members are not known until a run, so it names no key.
        const keys = expression.right.elements.map((element) => (element.type === 'spread' ? null : staticKey(element)));
        return keys.every((key): key is string => key !== null) ? keys : null;
      }
      return null;
    }
    case 'logical': {
      const each = expression.operands.map((operand) => requiredKeys(operand, keyIds));
      if (expression.op === 'and') {
        const keyed = each.filter((keys): keys is string[] => keys !== null);
        return keyed.length === 0 ? null : keyed.reduce((narrowed, keys) => narrowed.filter((key) => keys.includes(key)));
      }
      return each.every((keys): keys is string[] => keys !== null) ? [...new Set(each.flat())] : null;
    }
    default:
      return null;
  }
}

/**
 * The keys a listen on the shared inbox takes mail for: those its last hop's
 * WHERE requires `Key` to be (`e.Key == "deals"`, `e.Key IN [...]`), lowercased
 * as the door reads them. Empty when it takes mail whatever its key, or only
 * mail to the box itself (`e.Key == ""`), which is every team's.
 */
export function inboxKeysOf(plan: ListenPlan, fieldIds: Readonly<Record<string, Readonly<Record<string, string>>>> = {}): string[] {
  const last = plan.hops.at(-1);
  if (last === undefined) return [];
  const keyIds = new Set([EMAIL_KEY_FIELD, ...Object.values(fieldIds).flatMap((fields) => (fields[EMAIL_KEY_FIELD] !== undefined ? [fields[EMAIL_KEY_FIELD]] : []))]);
  const parts = [last.taken, last.checked].filter((part): part is Expression => part !== undefined);
  const keys = parts.length === 0 ? null : requiredKeys({ type: 'logical', op: 'and', operands: parts }, keyIds);
  return (keys ?? []).filter((key) => key !== '');
}

/** Why the save refuses `plan`, when it listens on the shared inbox without
 *  naming a key: it would hear no team's mail, since the door drops mail to
 *  the box itself. */
export function keylessInboxListen(plan: ListenPlan): string | null {
  if (!listensOnSharedInbox(plan) || inboxKeysOf(plan).length > 0) return null;
  return `the listen that fires ${plan.movement} hears ${EMAILS_EDGE} on the inbox every team shares without naming its key: mail is routed to a team by the plus-suffix it was sent to, so it would hear nothing. Name the key in its WHERE (\`${EMAILS_EDGE} WHERE e.${EMAIL_KEY_FIELD} == "deals"\` hears mail sent to inbox+deals@…)`;
}
